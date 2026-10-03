import type { Stage } from "@/api/types"

/**
 * The owner's published posts, attached to the pipeline stages as deep dives.
 * Titles are the owner's and kept verbatim; the one-line summaries are ours.
 * A curated file, not a fetch: no network call is made for the list.
 */

export type PostStage = "overview" | "source" | "parse" | "clean" | "chunk" | "index" | "retrieve" | "rerank" | "use_case" | "evaluate"
export interface Post { stage: PostStage; title: string; url: string; line: string; published: string }

const M = "https://medium.com/learnwithnk/"

export const POSTS: Post[] = [
  { stage: "overview", title: "Designing RAG Systems: Retrieval, Chunking, Re-ranking, Grounding", url: `${M}designing-rag-systems-retrieval-chunking-re-ranking-grounding-546f21eded2f`, line: "The whole pipeline as stages with their own failure modes and tests.", published: "2026-07-24" },
  { stage: "overview", title: "The RAG Pipeline as Building Blocks: Seven Ways an Answer Goes Wrong", url: `${M}the-rag-pipeline-as-building-blocks-seven-ways-an-answer-goes-wrong-2cae16e3a91c`, line: "Seven places an answer breaks, and which stage owns each.", published: "2026-09-16" },
  { stage: "overview", title: "A Framework for Deciding Where Retrieval Work Happens", url: `${M}a-framework-for-deciding-where-retrieval-work-happens-af3b5595d5da`, line: "When to send everything, filter first, index ahead, or search an existing system.", published: "2026-09-15" },
  { stage: "overview", title: "Fine-Tuning vs. RAG vs. Prompting: Choosing the Right Approach", url: `${M}fine-tuning-vs-rag-vs-prompting-choosing-the-right-approach-82d5f583b31c`, line: "Why RAG, and when it is not the answer.", published: "2026-07-27" },

  { stage: "source", title: "The Ingestion Pipeline: What You Ingest, What You Store, and What Starts the Rest", url: `${M}the-ingestion-pipeline-what-you-ingest-what-you-store-and-what-starts-the-rest-ed227b608b68`, line: "The four kinds of source and the one document they become.", published: "2026-09-19" },

  { stage: "parse", title: "Parsing Documents: PDFs, Tables, Scans and Layout", url: `${M}parsing-documents-pdfs-tables-scans-and-layout-949363696e17`, line: "Three tiers of parser, what each breaks on, and how to catch a bad parse.", published: "2026-09-28" },

  { stage: "clean", title: "Cleaning and Deduplication Before Anything Is Embedded", url: `${M}cleaning-and-deduplication-before-anything-is-embedded-f331e53c5162`, line: "Boilerplate, duplicates and broken blocks, removed before they are embedded.", published: "2026-09-28" },

  { stage: "chunk", title: "Chunking Fundamentals: What Chunk Size Actually Trades Off", url: `${M}chunking-fundamentals-what-chunk-size-actually-trades-off-216675ec62be`, line: "Why chunk size is a compromise and which strategy a corpus needs.", published: "2026-09-30" },
  { stage: "chunk", title: "Advanced Chunking: Parent-Child, Contextual Retrieval, Late Chunking and Hierarchical Summaries", url: `${M}advanced-chunking-parent-child-contextual-retrieval-late-chunking-and-hierarchical-summaries-e6ea55662d07`, line: "The strategies beyond size, and how to score them fairly.", published: "2026-10-02" },
  { stage: "chunk", title: "Metadata and Enrichment: What to Store Beside Each Chunk", url: `${M}metadata-and-enrichment-what-to-store-beside-each-chunk-fa19a3b63304`, line: "What travels with a chunk so it can be filtered, cited and ranked.", published: "2026-10-02" },

  { stage: "index", title: "Choosing and Operating an Embedding Model for RAG", url: `${M}choosing-and-operating-an-embedding-model-for-rag-8e81d6c2c49c`, line: "Picking an embedding model with hard filters, cost maths and cheap reindexing.", published: "2026-10-03" },
  { stage: "index", title: "Embeddings 101: How Text, Images, and Audio Become Vectors", url: `${M}embeddings-101-how-text-images-and-audio-become-vectors-594f30ae787c`, line: "What an embedding is, before anything else.", published: "2026-08-09" },
  { stage: "index", title: "Distance Metrics and Similarity Search: Cosine, Euclidean, and Dot Product", url: `${M}distance-metrics-and-similarity-search-cosine-euclidean-and-dot-product-f32b19d708c8`, line: "How closeness between vectors is measured.", published: "2026-08-15" },
  { stage: "index", title: "Embeddings & Vector Databases: Architecture and Trade-offs", url: `${M}embeddings-vector-databases-architecture-and-trade-offs-3ea9ce6f3159`, line: "Where the vectors live and what that costs.", published: "2026-07-25" },

  { stage: "retrieve", title: "Hybrid Search: Combining Vector Similarity with Metadata Filters and Keyword Search", url: `${M}hybrid-search-combining-vector-similarity-with-metadata-filters-and-keyword-search-cb5f7cc419ad`, line: "Meaning search and keyword search together, and when each wins.", published: "2026-08-29" },
  { stage: "retrieve", title: "Discover the Magic Behind Your Searches: How Semantic and Vector Search Transform Your Online Experience", url: `${M}semantic-and-vector-search-enhancing-your-online-search-experience-f8595ebf4f92`, line: "Semantic search explained from the reader's side.", published: "2024-09-20" },
  { stage: "retrieve", title: "Rediscovering Query Expansion: The Classic Technique Powering Modern AI Searches", url: `${M}rediscovering-query-expansion-the-classic-technique-powering-modern-ai-searches-d293a6d804d1`, line: "Making a short question find more.", published: "2024-09-16" },
  { stage: "retrieve", title: "The Mechanics of Query Expansion in RAG Systems: A Theoretical Exploration of PRF and LLM Techniques", url: `${M}the-mechanics-of-query-expansion-in-rag-systems-a-theoretical-exploration-of-prf-and-llm-6e66327ad300`, line: "Two ways to expand a query, and what each assumes.", published: "2024-09-16" },

  { stage: "evaluate", title: "A Baseline RAG and a Golden Set Before Any Optimisation", url: `${M}a-baseline-rag-and-a-golden-set-before-any-optimisation-c0c45de5847b`, line: "Measure before you tune: a baseline and the questions it must answer.", published: "2026-09-18" },
  { stage: "evaluate", title: "Evaluating LLM Systems: Offline Evals, Online Evals, LLM-as-Judge", url: `${M}evaluating-llm-systems-offline-evals-online-evals-llm-as-judge-cb4b462527b5`, line: "How to judge a system, offline and in production.", published: "2026-09-02" },
]

/** The posts for one stage, in list order. Card stages map one to one; stages with no posts give an empty list. */
export const postsFor = (stage: Stage | "overview" | "evaluate"): Post[] => POSTS.filter((p) => p.stage === stage)
