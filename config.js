// Public configuration. Everything here is meant to be visible in a browser:
// the anon key only opens what row-level security allows, and the API decides
// everything else server-side.
window.FB = {
  SUPABASE_URL: "https://data.familybusiness.se",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzI5NzI4MDAwLCJleHAiOjE4ODc0OTQ0MDB9.-no5XLl5bKtyA9RwXbfBfR0cw5ZTLOCogTNbq_BlGD8",
  API_BASE: "https://data.familybusiness.se/case-api",
  // This site's own repository, read only to stamp the footer with which
  // deployment the page came from. Public by definition — it is the repo that
  // serves this file.
  REPO: "CeFEO-JIBS/fb-cases-site",
  VERSION: "v0.5",
};
