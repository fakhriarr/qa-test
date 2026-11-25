import "./only";
// Request-scoped Auth client and service; durable truth lives exclusively in Supabase.
export { handleRequest as handle } from "./api";
