/**
 * CA Certificate Manager for auto-quiz HTTPS interception.
 *
 * Generates a self-signed root CA cert + key (once), stores in ~/.auto-quiz/.
 * Dynamically generates per-host certificates signed by the root CA for MITM.
 *
 * Only dependency: Node.js built-in `crypto` and `fs`.
 */

import crypto from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CA_DIR = join(homedir(), '.auto-quiz');
const CA_KEY_PATH = join(CA_DIR, 'ca-key.pem');
const CA_CERT_PATH = join(CA_DIR, 'ca-cert.pem');

// ============================================================================
// PEM helpers
// ============================================================================

function toPEM(der, label) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

function fromPEM(pem ) {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  return Buffer.from(b64, 'base64');
}

// ============================================================================
// Certificate extension helpers (simplified ASN.1)
// ============================================================================

/**
 * Build X.509v3 extensions — basicConstraints CA:true for root,
 * subjectAltName DNS:xxx for host certs.
 */
function buildExtensions(isCA, hostname) {
  const extOIDs = {
    basicConstraints: '2.5.29.19',
    subjectAltName:   '2.5.29.17',
    keyUsage:         '2.5.29.15',
    extendedKeyUsage: '2.5.29.37',
  };

  const exts = [];

  if (isCA) {
    // basicConstraints: CA:TRUE
    exts.push({
      oid: extOIDs.basicConstraints,
      critical: true,
      value: Buffer.from([0x30, 0x03, 0x01, 0x01, 0xFF]), // SEQUENCE { BOOLEAN TRUE }
    });
    // keyUsage: keyCertSign | cRLSign
    exts.push({
      oid: extOIDs.keyUsage,
      critical: true,
      value: Buffer.from([0x03, 0x02, 0x01, 0x06]), // BIT STRING (2 unused bits) 0x06 = 00000110
    });
  } else {
    // basicConstraints: CA:FALSE
    exts.push({
      oid: extOIDs.basicConstraints,
      critical: true,
      value: Buffer.from([0x30, 0x00]), // SEQUENCE {}
    });
    // subjectAltName: DNS:hostname
    const dnsBytes = Buffer.from(hostname, 'ascii');
    const sanValue = Buffer.concat([
      Buffer.from([0x30, dnsBytes.length + 2]),  // SEQUENCE
      Buffer.from([0x82, dnsBytes.length]),       // [2] (dNSName)
      dnsBytes,
    ]);
    exts.push({ oid: extOIDs.subjectAltName, critical: false, value: sanValue });
    // extendedKeyUsage: serverAuth
    exts.push({
      oid: extOIDs.extendedKeyUsage,
      critical: false,
      value: Buffer.from([0x30, 0x06, 0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01]),
    });
  }

  // Encode extensions as SEQUENCE
  const extSeq = exts.map(ext => {
    const oid = Buffer.concat([
      Buffer.from([0x06, extOIDsToBytes(ext.oid).length]),
      extOIDsToBytes(ext.oid),
    ]);
    const critical = ext.critical
      ? Buffer.from([0x01, 0x01, 0xFF])
      : Buffer.alloc(0);
    const val = Buffer.concat([
      Buffer.from([0x04, ext.value.length]),
      ext.value,
    ]);
    return Buffer.concat([
      Buffer.from([0x30, oid.length + critical.length + val.length]),
      oid, critical, val,
    ]);
  });
  const extValue = Buffer.concat(extSeq);
  return Buffer.concat([
    Buffer.from([0x30, extValue.length]),
    extValue,
  ]);
}

function extOIDsToBytes(oid) {
  const parts = oid.split('.').map(Number);
  const result = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    if (val < 128) {
      result.push(val);
    } else {
      const bytes = [];
      while (val > 0) {
        bytes.unshift(val & 0x7F);
        val >>= 7;
      }
      for (let j = 0; j < bytes.length - 1; j++) bytes[j] |= 0x80;
      result.push(...bytes);
    }
  }
  return Buffer.from(result);
}

// ============================================================================
// Certificate generation using Node.js crypto (no forge/openssl needed)
// ============================================================================

/**
 * Generate a 2048-bit RSA keypair or ECDSA (P-256).
 */
function generateKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
}

/**
 * Build an X.509v3 certificate (DER-encoded).
 *
 * We use a minimal but valid structure that mitmproxy-style tools accept.
 * Structure: TBSCertificate ::= SEQUENCE {
 *   version         [0] EXPLICIT INTEGER {2},
 *   serialNumber    INTEGER,
 *   signature       AlgorithmIdentifier,
 *   issuer          Name,
 *   validity        SEQUENCE { notBefore, notAfter },
 *   subject         Name,
 *   subjectPKInfo   SEQUENCE { algorithm, subjectPublicKey },
 *   extensions      [3] EXPLICIT Extensions
 * }
 */
function buildX509Cert({ serial, issuerName, subjectName, publicKeyDer, issuerKey, validDays, extensions }) {
  // Serial number as INTEGER
  const serialBytes = Buffer.alloc(16);
  serialBytes.writeBigUInt64BE(BigInt(serial), 8);
  // Trim leading zeros but keep at least 1 byte
  let serialTrimmed = serialBytes;
  while (serialTrimmed.length > 1 && serialTrimmed[0] === 0) serialTrimmed = serialTrimmed.subarray(1);
  const serialEnc = Buffer.concat([Buffer.from([0x02, serialTrimmed.length]), serialTrimmed]);

  // Validity
  const now = new Date();
  const notBefore = formatUTCTime(now);
  const notAfter = formatUTCTime(new Date(now.getTime() + validDays * 86400000));
  const validityEnc = Buffer.concat([
    Buffer.from([0x30, notBefore.length + notAfter.length]),
    notBefore,
    notAfter,
  ]);

  // Build Name (issuer/subject) — simple SEQUENCE of SET { SEQUENCE { OID, UTF8String } }
  function buildName(name) {
    const rdn = name.split('/').filter(Boolean).map(part => {
      const [key, ...rest] = part.split('=');
      const val = rest.join('=');
      const oidMap = { CN: '2.5.4.3', O: '2.5.4.10', C: '2.5.4.6', ST: '2.5.4.8', L: '2.5.4.7' };
      const oidBytes = extOIDsToBytes(oidMap[key] || key);
      const valBytes = Buffer.from(val, 'utf8');
      const attr = Buffer.concat([
        Buffer.from([0x06, oidBytes.length]), oidBytes,
        Buffer.from([0x0C, valBytes.length]), valBytes,
      ]);
      const seq = Buffer.concat([Buffer.from([0x30, attr.length]), attr]);
      return Buffer.concat([Buffer.from([0x31, seq.length]), seq]); // SET
    });
    const nameSeq = Buffer.concat(rdn);
    return Buffer.concat([Buffer.from([0x30, nameSeq.length]), nameSeq]);
  }

  const issuerEnc = buildName(issuerName);
  const subjectEnc = buildName(subjectName);

  // subjectPublicKeyInfo
  const pubKeyInfo = publicKeyDer;

  // Extensions
  const extBytes = extensions || Buffer.alloc(0);
  const extWrapped = Buffer.concat([
    Buffer.from([0xA3, extBytes.length + 2]), // [3] EXPLICIT
    Buffer.from([0x30, extBytes.length]),
    extBytes,
  ]);

  // Signature algorithm: sha256WithRSAEncryption (1.2.840.113549.1.1.11)
  const sigAlgOID = extOIDsToBytes('1.2.840.113549.1.1.11');
  const sigAlgEnc = Buffer.concat([
    Buffer.from([0x30, sigAlgOID.length + 2]),
    Buffer.from([0x06, sigAlgOID.length]), sigAlgOID,
    Buffer.from([0x05, 0x00]), // NULL
  ]);

  // TBSCertificate
  const version = Buffer.from([0xA0, 0x03, 0x02, 0x01, 0x02]); // [0] EXPLICIT INTEGER {2}
  const tbsContent = Buffer.concat([
    version, serialEnc, sigAlgEnc, issuerEnc, validityEnc,
    subjectEnc, pubKeyInfo, extWrapped,
  ]);
  const tbs = Buffer.concat([Buffer.from([0x30, tbsContent.length]), tbsContent]);

  // Sign
  const signer = crypto.createSign('sha256');
  signer.update(tbs);
  const signature = signer.sign({ key: issuerKey, format: 'der', type: 'pkcs8' });

  // Certificate
  const certContent = Buffer.concat([tbs, sigAlgEnc, Buffer.from([0x03, signature.length + 1, 0x00]), signature]);
  return Buffer.concat([Buffer.from([0x30, certContent.length]), certContent]);
}

function formatUTCTime(date) {
  const yy = date.getUTCFullYear().toString().slice(-2);
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  const str = `${yy}${mo}${dd}${hh}${mm}${ss}Z`;
  return Buffer.concat([
    Buffer.from([0x17, str.length]), // UTCTime
    Buffer.from(str, 'ascii'),
  ]);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Load or generate the root CA certificate + key.
 * Stored at ~/.auto-quiz/ca-key.pem and ~/.auto-quiz/ca-cert.pem
 *
 * @returns {Promise<{key: Buffer, cert: Buffer, certPEM: string}>}
 */
export async function loadOrCreateCA() {
  await mkdir(CA_DIR, { recursive: true });

  if (existsSync(CA_KEY_PATH) && existsSync(CA_CERT_PATH)) {
    const keyPEM = await readFile(CA_KEY_PATH, 'utf-8');
    const certPEM = await readFile(CA_CERT_PATH, 'utf-8');
    return {
      key: fromPEM(keyPEM),
      cert: fromPEM(certPEM),
      keyPEM,
      certPEM,
    };
  }

  // Generate new CA
  const { publicKey, privateKey } = generateKeyPair();

  const serial = Date.now();
  const certDer = buildX509Cert({
    serial,
    issuerName: '/CN=auto-quiz CA/O=auto-quiz/C=CN',
    subjectName: '/CN=auto-quiz CA/O=auto-quiz/C=CN',
    publicKeyDer: publicKey,
    issuerKey: privateKey,
    validDays: 3650, // 10 years
    extensions: buildExtensions(true),
  });

  const certPEM = toPEM(certDer, 'CERTIFICATE');
  const keyPEM = toPEM(privateKey, 'PRIVATE KEY');

  await writeFile(CA_KEY_PATH, keyPEM, 'utf-8');
  await writeFile(CA_CERT_PATH, certPEM, 'utf-8');

  console.log('[capture] CA certificate generated: %s', CA_CERT_PATH);
  console.log('[capture] Install this CA cert on your phone as a trusted root CA.');

  return { key: privateKey, cert: certDer, keyPEM, certPEM };
}

/**
 * Generate a per-host certificate signed by our root CA.
 *
 * @param {string} hostname - e.g. "x21854901.fengxueba.com"
 * @param {Buffer} caKey - Root CA private key (DER)
 * @param {Buffer} caCert - Root CA certificate (DER)
 * @returns {{ key: Buffer, cert: Buffer }} key + cert in DER format
 */
export function generateHostCert(hostname, caKey, caCert) {
  const { publicKey, privateKey } = generateKeyPair();

  const serial = Date.now();
  const certDer = buildX509Cert({
    serial,
    issuerName: '/CN=auto-quiz CA/O=auto-quiz/C=CN',
    subjectName: `/CN=${hostname}/O=auto-quiz/C=CN`,
    publicKeyDer: publicKey,
    issuerKey: caKey,
    validDays: 365, // 1 year
    extensions: buildExtensions(false, hostname),
  });

  return { key: privateKey, cert: certDer };
}

/**
 * Get PEM export path for CA cert (for user to install).
 */
export { CA_CERT_PATH };
