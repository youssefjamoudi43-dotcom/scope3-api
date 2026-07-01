import "dotenv/config";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import path from "path";
import { extractMetrics } from "./engine";
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import PDFDocument from "pdfkit";

console.log("Initializing server...");

const prisma = new PrismaClient();
const app = Fastify();

app.register(rateLimit, { max: 10, timeWindow: '1 minute' });
app.register(fastifyStatic, { root: path.join(process.cwd(), "public"), prefix: "/" });
app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

app.get("/health", async (request, reply) => {
  return { status: "ok", message: "Scope 3 API is running." };
});

app.get("/api/extractions", async (request, reply) => {
  const docs = await prisma.document.findMany({
    include: { extraction: true, supplier: true },
    orderBy: { createdAt: "desc" },
    take: 50
  });
  return reply.send(docs.map(d => ({
    id: d.id, supplier: d.supplier.name, timestamp: d.createdAt, 
    status: d.status, extractionId: d.extraction?.id,
    payload: d.extraction ? JSON.parse(d.extraction.payload) : null
  })));
});

app.post("/extract-document", async (request, reply) => {
  try {
    const data = await request.file();
    if (!data) return reply.status(400).send({ error: "No file uploaded." });

    const buffer = await data.toBuffer();
    
    if (data.mimetype === 'application/pdf' && buffer.toString('ascii', 0, 4) !== '%PDF') {
      return reply.status(400).send({ error: "Invalid PDF file." });
    }

    let rawText = "";
    if (data.mimetype === 'application/pdf') {
      const { extractText } = await import('unpdf');
      const uint8Array = new Uint8Array(buffer);
      const pdfData = await extractText(uint8Array, { mergePages: false });
      if (Array.isArray(pdfData.text)) {
        rawText = pdfData.text.map((p: string, i: number) => `--- PAGE ${i + 1} ---\n${p}`).join('\n\n');
      } else {
        rawText = String(pdfData.text);
      }
    } else {
      rawText = buffer.toString('utf-8');
    }

    const result = await extractMetrics(rawText);
    if (!result) return reply.status(422).send({ error: "Extraction failed validation after retries." });

    const sha256Hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const existingDoc = await prisma.document.findUnique({ where: { sha256Hash }, include: { extraction: true } });

    if (existingDoc && existingDoc.extraction) {
      return reply.send({ success: true, data: JSON.parse(existingDoc.extraction.payload), extractionId: existingDoc.extraction.id });
    }

    const slug = result.supplier_name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const supplier = await prisma.supplier.upsert({
      where: { slug },
      update: { name: result.supplier_name },
      create: { name: result.supplier_name, slug },
    });

    const doc = await prisma.document.create({
      data: {
        supplierId: supplier.id,
        sha256Hash,
        status: 'EXTRACTED',
        extraction: { create: { payload: JSON.stringify(result) } }
      },
      include: { extraction: true }
    });

    return reply.send({ success: true, data: result, extractionId: doc.extraction?.id });
  } catch (error) {
    console.error(error);
    return reply.status(500).send({ error: "Document Extraction failed." });
  }
});

app.get("/api/export/:extractionId", async (request: any, reply: any) => {
  try {
    const { extractionId } = request.params;
    const hasLicense = true; // Demo mode

    if (!hasLicense) {
      return reply.status(403).send({ error: "PAYWALL" });
    }

    const doc = await prisma.document.findFirst({
      where: { extraction: { id: extractionId } },
      include: { extraction: true }
    });

    if (!doc || !doc.extraction) return reply.status(404).send({ error: "Not found" });

    const payload = JSON.parse(doc.extraction.payload);
    
    // Generate Forensic PDF
    const pdfDoc = new PDFDocument({ margin: 50, size: 'A4' });
    
    const chunks: Buffer[] = [];
    pdfDoc.on('data', (chunk: Buffer) => chunks.push(chunk));
    
    const finishPromise = new Promise<Buffer>((resolve) => {
      pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
    });

    // Header
    pdfDoc.fontSize(20).fillColor('#6366f1').text('Forensic Audit Evidence Package', { align: 'center' });
    pdfDoc.moveDown(0.5);
    pdfDoc.fontSize(14).fillColor('black').text(payload.supplier_name, { align: 'center' });
    pdfDoc.fontSize(10).fillColor('#666').text('Reporting Period: FY ' + payload.reporting_period, { align: 'center' });
    pdfDoc.moveDown(1);

    // Table Headers
    const tableTop = 150;
    const colX = { metric: 50, value: 180, page: 280, conf: 330, evidence: 400 };

    pdfDoc.fontSize(10).fillColor('#000').font('Helvetica-Bold');
    pdfDoc.text('Metric', colX.metric, tableTop);
    pdfDoc.text('Value', colX.value, tableTop);
    pdfDoc.text('Page', colX.page, tableTop);
    pdfDoc.text('Confidence', colX.conf, tableTop);
    pdfDoc.text('Source Evidence', colX.evidence, tableTop);
    pdfDoc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
    
    // Table Rows
    pdfDoc.font('Helvetica').fontSize(9);
    let y = tableTop + 30;

    payload.metrics.forEach((m: any) => {
      if (y > 700) { 
        pdfDoc.addPage(); 
        y = 50; 
      }
      pdfDoc.fillColor('#000').text(m.metric_name.replace(/_/g, ' '), colX.metric, y, { width: 120 });
      pdfDoc.text(m.value.toLocaleString() + ' ' + m.unit, colX.value, y, { width: 90 });
      pdfDoc.text(String(m.page_number), colX.page, y, { width: 40 });
      pdfDoc.fillColor('#14532d').text(m.confidence_score + '%', colX.conf, y, { width: 60 });
      pdfDoc.fillColor('#444').font('Helvetica-Oblique').text('"' + m.source_quote + '"', colX.evidence, y, { width: 150 });
      pdfDoc.font('Helvetica');
      y += 40; 
    });

    // Footer with Hash
    pdfDoc.moveDown(4);
    pdfDoc.fontSize(8).fillColor('#999').text('File Integrity Hash (SHA-256):', 50);
    pdfDoc.text(doc.sha256Hash, 50);
    pdfDoc.text('Audit Trail ID: ' + extractionId, 50);

    pdfDoc.end();

    const pdfBuffer = await finishPromise;

    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', 'attachment; filename="audit-evidence-' + extractionId + '.pdf"');
    return reply.send(pdfBuffer);
  } catch (error) {
    console.error(error);
    return reply.status(500).send({ error: "Export failed" });
  }
});

const start = async () => {
  try {
    await app.listen({ port: 3000 });
    console.log("Server listening on http://localhost:3000");
  } catch (err) {
    console.error("SERVER FAILED TO START:", err);
    process.exit(1);
  }
};

start();
