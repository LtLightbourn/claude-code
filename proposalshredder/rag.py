"""RAG over the capability library: ChromaDB ingestion and semantic search."""

import json
import logging
from pathlib import Path

from pdf_utils import extract_pdf_text

logger = logging.getLogger("proposalshredder")

CHUNK_SIZE = 800
CHUNK_OVERLAP = 100
TOP_K = 5

CACHE_DIRNAME = ".proposalshredder"
COLLECTION_NAME = "capability_library"


class CapabilityLibrary:
    """Vector store over a folder of past-performance PDFs.

    Embeddings persist in ``<library>/.proposalshredder`` so re-runs skip
    ingestion unless the library folder has changed (compared by file
    path + modification time).
    """

    def __init__(self, library_dir, mock=False):
        self.library_dir = Path(library_dir)
        self.cache_dir = self.library_dir / CACHE_DIRNAME
        self.mock = mock
        self.collection = None

    @property
    def is_empty(self):
        return not self._pdf_files()

    def _pdf_files(self):
        return sorted(
            p for p in self.library_dir.glob("*.pdf") if p.is_file()
        )

    def _manifest(self):
        return {
            str(path.name): path.stat().st_mtime
            for path in self._pdf_files()
        }

    def ingest(self, progress=None):
        """Ingest library PDFs into ChromaDB, skipping if unchanged."""
        if self.is_empty:
            logger.warning(
                "Capability library folder %s contains no PDFs. Drafting "
                "will proceed using only the RFP context.", self.library_dir,
            )
            return

        import chromadb

        self.cache_dir.mkdir(exist_ok=True)
        client = chromadb.PersistentClient(path=str(self.cache_dir / "chroma"))
        manifest_path = self.cache_dir / "manifest.json"
        manifest = self._manifest()

        if manifest_path.exists():
            try:
                cached = json.loads(manifest_path.read_text())
            except (OSError, json.JSONDecodeError):
                cached = None
            if cached == manifest:
                try:
                    self.collection = client.get_collection(
                        COLLECTION_NAME,
                        embedding_function=self._embedding_function(),
                    )
                    if progress:
                        progress("  Library unchanged; reusing stored "
                                 "embeddings.")
                    return
                except Exception:
                    pass  # collection missing/corrupt; re-ingest below

        try:
            client.delete_collection(COLLECTION_NAME)
        except Exception:
            pass
        self.collection = client.create_collection(
            COLLECTION_NAME, embedding_function=self._embedding_function(),
        )

        for path in self._pdf_files():
            if progress:
                progress(f"  Ingesting {path.name}...")
            pages, skipped = extract_pdf_text(path)
            if skipped and progress:
                progress(
                    f"    Warning: {len(skipped)} page(s) of {path.name} "
                    "had no extractable text and were skipped."
                )
            text = "\n\n".join(page["text"] for page in pages)
            chunks = chunk_text(text)
            if not chunks:
                continue
            self.collection.add(
                ids=[f"{path.name}::{i}" for i in range(len(chunks))],
                documents=chunks,
                metadatas=[{"source": path.name} for _ in chunks],
            )

        manifest_path.write_text(json.dumps(manifest, indent=1))

    def search(self, query, top_k=TOP_K):
        """Return the top_k most relevant chunks for a requirement."""
        if self.collection is None:
            return []
        result = self.collection.query(
            query_texts=[query],
            n_results=min(top_k, max(self.collection.count(), 1)),
        )
        documents = result.get("documents", [[]])[0]
        metadatas = result.get("metadatas", [[]])[0]
        return [
            {"source": meta.get("source", "unknown"), "text": doc}
            for doc, meta in zip(documents, metadatas)
        ]

    def _embedding_function(self):
        if self.mock:
            return _HashEmbeddingFunction()
        return None  # ChromaDB default (local ONNX MiniLM model)


class _HashEmbeddingFunction:
    """Deterministic bag-of-words hash embedding for --mock runs.

    Avoids downloading ChromaDB's default embedding model while still
    exercising ingestion and retrieval end to end.
    """

    DIMENSIONS = 128

    def name(self):
        return "proposalshredder-mock-hash"

    def __call__(self, input):
        return [self._embed(text) for text in input]

    def embed_query(self, input):
        return self(input)

    def _embed(self, text):
        import zlib

        vector = [0.0] * self.DIMENSIONS
        for word in text.lower().split():
            vector[zlib.crc32(word.encode()) % self.DIMENSIONS] += 1.0
        norm = sum(v * v for v in vector) ** 0.5 or 1.0
        return [v / norm for v in vector]


def chunk_text(text, size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """Split text into overlapping chunks."""
    text = text.strip()
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        chunks.append(text[start:start + size])
        if start + size >= len(text):
            break
        start += size - overlap
    return chunks
