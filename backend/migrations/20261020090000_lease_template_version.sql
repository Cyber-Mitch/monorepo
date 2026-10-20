-- Record which lease template a generated document was rendered from (#1954).
-- document_hash (added in 20261019211000) now holds the SHA-256 of the PDF
-- bytes; template_version lets a signed document be tied to its wording.
ALTER TABLE lease_agreements ADD COLUMN IF NOT EXISTS template_version TEXT;
