/**
 * Tool `lookup_customer` — sucht einen Kunden anhand der Telefonnummer in MongoDB.
 * Beispiel für ein client_side-Tool mit DB-Zugriff.
 */
import { Customer } from "../../db/models/Customer.js";
import type { Tool } from "../registry.js";

export const lookupCustomer: Tool = {
  name: "lookup_customer",
  description: "Sucht einen Kunden anhand seiner Telefonnummer und liefert Name und Notizen.",
  parameters: {
    type: "object",
    properties: {
      phone: { type: "string", description: "Telefonnummer im E.164-Format, z.B. +49301234567" },
    },
    required: ["phone"],
  },
  async handler(args, ctx) {
    const phone = String(args.phone ?? ctx.callerNumber ?? "").trim();
    if (!phone) return { found: false, reason: "Keine Telefonnummer angegeben." };
    const customer = await Customer.findOne({ phone }).lean();
    if (!customer) return { found: false, phone };
    return { found: true, phone, name: customer.name ?? null, notes: customer.notes ?? null };
  },
};
