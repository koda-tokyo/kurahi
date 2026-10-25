# Rules: claims and sources

1. `corpus/` and `knowledge/` are read-only. Open-access PDFs fetched with `scholar_fetch_pdf`
   land in `corpus-inbox/` after quarantine and a malware scan.
2. Every claim cites a file in `corpus/` or `corpus-inbox/` (and the page or section when known),
   or a work retrieved with the scholar tools (DOI, arXiv id or PMID).
3. Cite only works that exist in the corpus or that a scholar tool returned. Never invent an
   author, year, title, journal or DOI. Check a draft's references with `scholar_cite_check`.
4. If the sources do not answer the question, say so.
5. Never submit a paper or a grant application and never contact research participants. Never
   write that anything was submitted, accepted or funded.
