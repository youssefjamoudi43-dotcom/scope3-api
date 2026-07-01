import { z } from "zod";

export const ExtractedMetricSchema = z.object({
  metric_name: z.enum([
    // Environmental
    "scope_1_emissions_tco2e",
    "scope_2_emissions_tco2e",
    "scope_3_emissions_tco2e",
    "total_energy_consumption_kwh",
    "renewable_energy_percentage",
    "water_withdrawal_m3",
    "waste_diverted_percentage",
    // Social
    "total_recordable_incident_rate_trir",
    "female_workforce_percentage",
    "training_hours_per_employee",
    // Governance
    "independent_board_members_percentage",
    "ethics_training_completion_percentage"
  ]),
  value: z.number().nonnegative(),
  unit: z.string(),
  source_quote: z.string(),
  page_number: z.number().int().positive(),
  confidence_score: z.number().min(0).max(100)
});

export const ExtractionPayloadSchema = z.object({
  supplier_name: z.string(),
  reporting_period: z.string().regex(/^\d{4}$/, "Must be a valid 4-digit year"),
  metrics: z.array(ExtractedMetricSchema),
}).strict();

export type ExtractionPayload = z.infer<typeof ExtractionPayloadSchema>;
export type ExtractedMetric = z.infer<typeof ExtractedMetricSchema>;
