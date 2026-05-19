import re
import hashlib
from typing import List, Dict, Any, Optional
from pathlib import Path
import chromadb
from chromadb.config import Settings


class VectorStoreManager:
    def __init__(self, persist_dir: str = "vector_db"):
        self.persist_dir = Path(persist_dir)
        self.persist_dir.mkdir(parents=True, exist_ok=True)

        self.client = chromadb.PersistentClient(
            path=str(self.persist_dir),
            settings=Settings(anonymized_telemetry=False)
        )

        self.collection = self.client.get_or_create_collection(
            name="knowledge_base",
            metadata={"description": "Knowledge base vector store"}
        )

        self._embedding_cache = {}

    def _generate_doc_id(self, doc_id: str, chunk_index: int) -> str:
        content = f"{doc_id}_{chunk_index}"
        return hashlib.md5(content.encode()).hexdigest()

    def _chunk_markdown(self, text: str, doc_id: str) -> List[Dict[str, Any]]:
        sections = re.split(r'(?=^#{2,3}\s)', text, flags=re.MULTILINE)
        chunks = []

        for i, section in enumerate(sections):
            section = section.strip()
            if not section:
                continue

            header_match = re.match(r'^(#{2,3})\s+(.+)$', section, re.MULTILINE)
            if header_match:
                level = len(header_match.group(1))
                title = header_match.group(2).strip()
                content = section[len(header_match.group(0)):].strip()
                chunk_text = f"{title}\n{content}" if content else title
            else:
                chunk_text = section

            if len(chunk_text) < 10:
                continue

            chunks.append({
                "text": chunk_text,
                "metadata": {
                    "doc_id": doc_id,
                    "chunk_index": i,
                    "chunk_type": "header",
                    "char_count": len(chunk_text)
                }
            })

        return chunks

    def _chunk_by_paragraph(self, text: str, doc_id: str, chunk_size: int = 500) -> List[Dict[str, Any]]:
        paragraphs = re.split(r'\n\n+', text)
        chunks = []
        current_chunk = []
        current_length = 0

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue

            para_length = len(para)

            if current_length + para_length > chunk_size and current_chunk:
                chunks.append({
                    "text": "\n\n".join(current_chunk),
                    "metadata": {
                        "doc_id": doc_id,
                        "chunk_index": len(chunks),
                        "chunk_type": "paragraph",
                        "char_count": sum(len(p) for p in current_chunk)
                    }
                })
                current_chunk = []
                current_length = 0

            current_chunk.append(para)
            current_length += para_length

        if current_chunk:
            chunks.append({
                "text": "\n\n".join(current_chunk),
                "metadata": {
                    "doc_id": doc_id,
                    "chunk_index": len(chunks),
                    "chunk_type": "paragraph",
                    "char_count": sum(len(p) for p in current_chunk)
                }
            })

        return chunks

    def index_document(self, doc_id: str, content: str, metadata: Dict[str, Any] = None) -> int:
        self.delete_index(doc_id)

        file_ext = metadata.get("type", "txt") if metadata else "txt"

        if file_ext == "md":
            chunks = self._chunk_markdown(content, doc_id)
        else:
            chunks = self._chunk_by_paragraph(content, doc_id)

        if not chunks:
            return 0

        ids = [self._generate_doc_id(doc_id, i) for i in range(len(chunks))]
        texts = [chunk["text"] for chunk in chunks]
        metadatas = [chunk["metadata"] for chunk in chunks]

        self.collection.add(
            ids=ids,
            documents=texts,
            metadatas=metadatas
        )

        return len(chunks)

    def query(self, text: str, n_results: int = 6, doc_id: str = None) -> List[Dict[str, Any]]:
        where_filter = {"doc_id": doc_id} if doc_id else None

        results = self.collection.query(
            query_texts=[text],
            n_results=n_results,
            where=where_filter
        )

        if not results or not results.get("documents") or not results["documents"][0]:
            return []

        chunks = []
        for i, doc in enumerate(results["documents"][0]):
            chunk = {
                "text": doc,
                "distance": results["distances"][0][i] if results.get("distances") else 0,
                "metadata": results["metadatas"][0][i] if results.get("metadatas") else {}
            }
            chunks.append(chunk)

        return chunks

    def is_indexed(self, doc_id: str) -> bool:
        results = self.collection.get(
            where={"doc_id": doc_id},
            limit=1
        )
        return len(results.get("ids", [])) > 0

    def get_indexed_chunks_count(self, doc_id: str) -> int:
        results = self.collection.get(
            where={"doc_id": doc_id}
        )
        return len(results.get("ids", []))

    def delete_index(self, doc_id: str):
        try:
            existing = self.collection.get(where={"doc_id": doc_id})
            if existing and existing.get("ids"):
                self.collection.delete(ids=existing["ids"])
        except Exception:
            pass

    def get_all_indexed_docs(self) -> List[str]:
        try:
            all_data = self.collection.get()
            doc_ids = set()
            for meta in all_data.get("metadatas", []):
                if meta and "doc_id" in meta:
                    doc_ids.add(meta["doc_id"])
            return list(doc_ids)
        except Exception:
            return []

    def clear_all(self):
        try:
            self.client.delete_collection(name="knowledge_base")
            self.collection = self.client.get_or_create_collection(
                name="knowledge_base",
                metadata={"description": "Knowledge base vector store"}
            )
        except Exception:
            pass
