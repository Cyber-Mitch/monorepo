/**
 * Lease document integrity (#1960).
 *
 * The hash recorded when a lease is generated is compared against a fresh hash
 * of the stored document bytes. When no object store is configured (local
 * development / unit tests) the document key itself is treated as the document
 * content, which is how leases created before real PDFs were generated (#1954)
 * recorded their hash. For current leases `hashStoredDocument` hashes the PDF bytes.
 */

import { createHash } from 'node:crypto'
import { getStorageProvider } from './storageService.js'
import { computeLeaseDocumentHash } from './leaseDocumentService.js'

export interface LeaseIntegrityResult {
  /** True when the stored document still matches the recorded hash. */
  valid: boolean
  /** Freshly computed hash of the stored document. */
  documentHash: string
  /** Hash recorded at generation time (empty when unknown/legacy). */
  recordedHash: string
  documentVersion: string
  lastModified: string
}

/**
 * Hash the document stored at `documentKey`. Falls back to hashing the key when
 * the object is not present in storage (e.g. tests / object not yet uploaded).
 */
export async function hashStoredDocument(documentKey: string): Promise<string> {
  try {
    const { buffer } = await getStorageProvider().downloadFile(documentKey)
    return createHash('sha256').update(buffer).digest('hex')
  } catch {
    return computeLeaseDocumentHash(documentKey)
  }
}

/** Derive a human-readable document version from the storage key. */
export function documentVersionFromKey(documentKey: string): string {
  const last = documentKey.split('/').pop()
  return last && last.length > 0 ? last : 'v1'
}

export async function checkDocumentIntegrity(params: {
  documentKey: string
  recordedHash?: string
  lastModified: Date
}): Promise<LeaseIntegrityResult> {
  const actualHash = await hashStoredDocument(params.documentKey)
  const recordedHash = params.recordedHash ?? ''
  // A legacy lease with no recorded hash cannot be proven tampered; treat the
  // freshly-derived hash as authoritative in that case.
  const valid = recordedHash === '' ? true : actualHash === recordedHash

  return {
    valid,
    documentHash: actualHash,
    recordedHash,
    documentVersion: documentVersionFromKey(params.documentKey),
    lastModified: params.lastModified.toISOString(),
  }
}
