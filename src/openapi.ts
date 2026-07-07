import { ATTRIBUTION } from "./attribution";

export function buildOpenApiDocument(origin: string): Record<string, unknown> {
  const queryParameters = [
    {
      name: "interests",
      in: "query",
      required: true,
      description:
        "Comma-separated list of interest phrases (1-5 phrases, each up to 100 characters). Required.",
      schema: { type: "string" },
      example: "formal methods, llm verification",
    },
    {
      name: "days",
      in: "query",
      required: false,
      description: "How many days back to search. Clamped to [1, 30]. Default 7.",
      schema: { type: "integer", minimum: 1, maximum: 30, default: 7 },
    },
    {
      name: "max",
      in: "query",
      required: false,
      description: "Maximum number of papers to return. Clamped to [1, 10]. Default 10.",
      schema: { type: "integer", minimum: 1, maximum: 10, default: 10 },
    },
    {
      name: "min_score",
      in: "query",
      required: false,
      description:
        "Minimum relevance score required to include a paper. Clamped to [0, 1]. Defaults to the server's MIN_SCORE setting.",
      schema: { type: "number", minimum: 0, maximum: 1 },
    },
    {
      name: "categories",
      in: "query",
      required: false,
      description: "Comma-separated list of arXiv category codes to restrict results to (e.g. cs.LO,cs.CL).",
      schema: { type: "string" },
      example: "cs.LO,cs.CL",
    },
  ];

  const formatParameter = {
    name: "format",
    in: "query",
    required: false,
    description: "Response format. Only relevant for /api/papers; /api/digest always returns markdown.",
    schema: { type: "string", enum: ["json"], default: "json" },
  };

  const rankedPaperSchema = {
    type: "object",
    properties: {
      id: { type: "string", description: "arXiv identifier, e.g. 2507.01234" },
      title: { type: "string" },
      abstract: { type: "string" },
      authors: { type: "array", items: { type: "string" } },
      categories: { type: "array", items: { type: "string" } },
      primary_category: { type: "string" },
      published: { type: "string", format: "date-time" },
      published_ts: { type: "integer", description: "Epoch seconds" },
      abs_url: { type: "string", format: "uri" },
      pdf_url: { type: "string", format: "uri" },
      tldr: {
        type: "string",
        description:
          "2-3 sentence AI-generated summary when available; otherwise the opening of the abstract as a fallback. Never null.",
      },
      author_notes: {
        type: ["object", "null"],
        additionalProperties: { type: "string" },
      },
      score: { type: "number", minimum: 0, maximum: 1 },
      relevance_blurb: { type: ["string", "null"] },
    },
    required: [
      "id",
      "title",
      "abstract",
      "authors",
      "categories",
      "primary_category",
      "published",
      "published_ts",
      "abs_url",
      "pdf_url",
      "tldr",
      "author_notes",
      "score",
      "relevance_blurb",
    ],
  };

  const papersResponseSchema = {
    type: "object",
    properties: {
      query: {
        type: "object",
        properties: {
          interests: { type: "array", items: { type: "string" } },
          days: { type: "integer" },
          max: { type: "integer" },
          min_score: { type: "number" },
          categories: { type: "array", items: { type: "string" } },
        },
        required: ["interests", "days", "max", "min_score", "categories"],
      },
      ranking: { type: "string", enum: ["semantic", "keyword"] },
      generated_at: { type: "string", format: "date-time" },
      note: { type: "string" },
      papers: { type: "array", items: { $ref: "#/components/schemas/RankedPaper" } },
      attribution: { type: "string" },
    },
    required: ["query", "ranking", "generated_at", "papers", "attribution"],
  };

  const errorResponseSchema = {
    type: "object",
    properties: {
      error: { type: "string" },
    },
    required: ["error"],
  };

  const healthResponseSchema = {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      last_ingest: {
        description: "Last known ingest state, or null if ingest has never run.",
        nullable: true,
        type: "object",
        properties: {
          date: { type: "string" },
          start: { type: "integer" },
          sinceTs: { type: "integer" },
          done: { type: "boolean" },
          total: { type: ["integer", "null"] },
        },
      },
      article_count: { type: "integer" },
      gen_budget_remaining: { type: "integer" },
    },
    required: ["ok", "last_ingest", "article_count", "gen_budget_remaining"],
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "arxiv-report",
      version: "1.0.0",
      description:
        "A personalized arXiv digest API. Ranks recent arXiv papers by relevance to your stated interests, " +
        `using semantic (embedding-based) ranking when available and falling back to keyword matching otherwise. ${ATTRIBUTION}`,
    },
    servers: [{ url: origin }],
    paths: {
      "/api/papers": {
        get: {
          summary: "Get ranked arXiv papers matching your interests",
          operationId: "getPapers",
          parameters: [...queryParameters, formatParameter],
          responses: {
            "200": {
              description: "Ranked papers matching the query",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/PapersResponse" } },
              },
            },
            "400": {
              description: "Invalid query parameters",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/digest": {
        get: {
          summary: "Get a markdown digest of ranked arXiv papers matching your interests",
          operationId: "getDigest",
          parameters: queryParameters,
          responses: {
            "200": {
              description: "Markdown-formatted digest",
              content: {
                "text/markdown": { schema: { type: "string" } },
              },
            },
            "400": {
              description: "Invalid query parameters",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/health": {
        get: {
          summary: "Service health and status",
          operationId: "getHealth",
          responses: {
            "200": {
              description: "Health status",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/HealthResponse" } },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        RankedPaper: rankedPaperSchema,
        PapersResponse: papersResponseSchema,
        ErrorResponse: errorResponseSchema,
        HealthResponse: healthResponseSchema,
      },
    },
  };
}
