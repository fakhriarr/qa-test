// Server modules must never enter a browser bundle.
if (typeof window !== "undefined") throw new Error("Server-only module");
