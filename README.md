# ESG Audit Acceleration Platform

An enterprise-grade AI pipeline that extracts CSRD/ESG metrics from supplier PDFs with page-level traceability, confidence scoring, and forensic audit exports.

## Architecture Pipeline

\`\`\`
PDF Upload → Text Extraction (unpdf) → LLM Extraction (Groq/Llama 3.3) 
→ Zod Schema Validation → Hallucination Detection (Fuzzy Matching) 
→ SHA-256 Hashing → PostgreSQL/SQLite (Prisma) → Forensic PDF Export
\`\`\`

## Key Features

- **Deterministic Extraction:** Caged LLM output using strict Zod schemas.
- **Hallucination Firewall:** Citation verification with unit-math fallback (MWh to kWh).
- **Smart Sizing:** Automatically chunks documents >6,000 words to avoid context limits.
- **Immutable Audit Trail:** SHA-256 hashing prevents duplicate processing.
- **Forensic Exports:** Generates paginated PDF evidence packages for auditors.

## Getting Started

### Prerequisites
- Node.js v18+
- Groq API Key

### Installation

1. Clone the repository.
2. Copy \`\`.env.example\`\` to \`\`.env\`\` and fill in your keys.
3. Install dependencies:
   \`\`\`bash
   npm install
   \`\`\`
4. Push the database schema:
   \`\`\`bash
   npx prisma db push
   \`\`\`
5. Start the server:
   \`\`\`bash
   npm run dev
   \`\`\`

### Docker Deployment

\`\`\`bash
docker-compose up --build
\`\`\`

## API Endpoints

- \`\`POST /extract-document\`\`: Upload a PDF/TXT file for extraction.
- \`\`GET /api/extractions\`\`: Fetch audit history.
- \`\`GET /api/export/:extractionId\`\`: Download forensic PDF.

## Tech Stack

- **Backend:** Fastify, TypeScript
- **AI:** Groq (Llama 3.3 70B)
- **Database:** Prisma, SQLite/PostgreSQL
- **PDF:** unpdf, PDFKit
