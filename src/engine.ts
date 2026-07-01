import OpenAI from "openai";
import { ExtractionPayloadSchema, ExtractionPayload } from "./schemas";

let groqClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!groqClient) {
    if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is missing.");
    groqClient = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });
  }
  return groqClient;
}

function normalize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function verifyCitations(payload: ExtractionPayload, rawText: string): boolean {
  const normalizedRawText = normalize(rawText);
  for (const metric of payload.metrics) {
    const normalizedQuote = normalize(metric.source_quote);
    if (normalizedRawText.includes(normalizedQuote)) continue; 

    const numericValue = normalize(String(metric.value));
    const valueDivided1000 = normalize(String(metric.value / 1000));
    const valueDivided1mil = normalize(String(metric.value / 1000000));

    if (numericValue.length > 2 && normalizedRawText.includes(numericValue)) continue; 
    if (valueDivided1000.length > 2 && normalizedRawText.includes(valueDivided1000)) continue; 
    if (valueDivided1mil.length > 2 && normalizedRawText.includes(valueDivided1mil)) continue; 

    console.error(`[HALLUCINATION DETECTED] Quote/Value not found: "${metric.source_quote}"`);
    return false;
  }
  return true;
}

function chunkText(text: string): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  const chunkSize = 3000;
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(' '));
  }
  return chunks;
}

export async function extractMetrics(rawText: string): Promise<ExtractionPayload | null> {
  const client = getClient();
  const wordCount = rawText.split(' ').length;
  console.log(`Document length: ${wordCount} words.`);
  
  // SMART SIZING: Only chunk if the document is massive (> 6000 words)
  const chunks = wordCount > 6000 ? chunkText(rawText) : [rawText];
  console.log(`Processing in ${chunks.length} part(s)...`);

  let aggregatedMetrics: any[] = [];
  let supplierName = "Unknown Supplier";
  let reportingPeriod = new Date().getFullYear().toString();

  const schemaInstructions = `You are an expert CSRD/ESG compliance extraction engine. 
Extract the full ESG matrix from the provided text.

CRITICAL EXTRACTION RULES:
1. Contextual Accuracy: Do NOT extract a metric if the text says it is "being evaluated", "not yet reported", "N/A", or refers to a future target. Only extract explicitly reported historical data.
2. Hierarchy: Only extract corporate-wide or facility-wide TOTALS.
3. Unit Math: MWh to kWh (x1000), GWh to kWh (x1000000). source_quote must contain original value/unit.
4. Strictly NO null values. Omit if not found.
5. PAGE NUMBER: Text is divided by "--- PAGE X ---". Read and include the page number.
6. CONFIDENCE SCORE: 0-100 certainty level.
7. ABSOLUTELY NO ELLIPSIS (...) IN QUOTES. Compress whitespace for tables if needed.
8. METRIC NAMES: You MUST map the data to these EXACT metric_name strings. Do not invent your own strings.

Allowed metric_name values:
- "scope_1_emissions_tco2e"
- "scope_2_emissions_tco2e"
- "scope_3_emissions_tco2e"
- "total_energy_consumption_kwh"
- "renewable_energy_percentage"
- "water_withdrawal_m3"
- "waste_diverted_percentage"
- "total_recordable_incident_rate_trir"
- "female_workforce_percentage"
- "training_hours_per_employee"
- "independent_board_members_percentage"
- "ethics_training_completion_percentage"

JSON Structure:
{
  "supplier_name": "string" (if found),
  "reporting_period": "4-digit year string" (if found),
  "metrics": [
    {
      "metric_name": "one of the allowed values above",
      "value": number,
      "unit": "string",
      "source_quote": "exact verbatim quote",
      "page_number": number,
      "confidence_score": number
    }
  ]
}`;

  for (let i = 0; i < chunks.length; i++) {
    console.log(`Processing chunk ${i + 1} of ${chunks.length}...`);
    const maxRetries = 3;
    let attempt = 0;
    
    while (attempt < maxRetries) {
      try {
        const response = await client.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: schemaInstructions },
            { role: "user", content: `RAW TEXT:\n${chunks[i]}` },
          ],
        });

        const content = response.choices[0].message.content;
        if (!content) throw new Error("Empty response");

        const llmOutput = JSON.parse(content);
        
        if (llmOutput.supplier_name && supplierName === "Unknown Supplier") supplierName = llmOutput.supplier_name;
        if (llmOutput.reporting_period) reportingPeriod = llmOutput.reporting_period;
        
        if (llmOutput.metrics && Array.isArray(llmOutput.metrics)) {
          const validMetrics = llmOutput.metrics.filter((m: any) => 
            m && m.value !== null && m.unit !== null && m.source_quote !== null && m.page_number !== null && m.confidence_score !== null
          ).map((m: any) => {
            m.source_quote = m.source_quote.replace(/\.\.\./g, ' ').replace(/\s+/g, ' ').trim();
            return m;
          });
          aggregatedMetrics.push(...validMetrics);
        }
        break; 
      } catch (error: any) {
        console.error(`[Chunk ${i+1} Attempt ${attempt + 1} Failed] ${error.message}`);
        attempt++;
        if (attempt >= maxRetries) {
          console.log(`Skipping chunk ${i + 1} after 3 failed attempts.`);
        }
        await new Promise(res => setTimeout(res, 1000 * attempt));
      }
    }
  }

  // Deduplicate metrics (keep the one with the highest confidence)
  const uniqueMetrics: any[] = [];
  const metricMap = new Map<string, any>();
  
  for (const m of aggregatedMetrics) {
    const existing = metricMap.get(m.metric_name);
    if (!existing || m.confidence_score > existing.confidence_score) {
      metricMap.set(m.metric_name, m);
    }
  }
  uniqueMetrics.push(...metricMap.values());

  const finalPayload = {
    supplier_name: supplierName,
    reporting_period: reportingPeriod,
    metrics: uniqueMetrics
  };

  const validationResult = ExtractionPayloadSchema.safeParse(finalPayload);
  if (!validationResult.success) {
    console.error("[VALIDATION FAILED]", validationResult.error.issues);
    return null;
  }

  if (!verifyCitations(validationResult.data, rawText)) return null; 

  console.log(`Extraction successful. ${uniqueMetrics.length} unique metrics verified.`);
  return validationResult.data;
}
