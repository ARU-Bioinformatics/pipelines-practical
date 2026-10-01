/* =====================================================================
   Settings for the "Pipelines and reproducibility" practical.
   Edit and re-upload this file; nothing else needs to change.
   ===================================================================== */
window.MG_CONFIG = {
  courseTitle: 'Pipelines and reproducibility',
  courseSubtitle: 'From commands to Snakemake and Galaxy – and what an AI agent cannot prove',
  storePrefix: 'pipelines',
  hostname: 'biolab',

  /* true: students can reveal model answers after trying a question.
     false: the "Show answer" buttons are hidden (add ?answers to the address to see them).
     The answers are still in the page source, so this is not a way to keep them secret. */
  showModelAnswers: true,

  /* Python in the browser (Pyodide). To host it with the site instead of the CDN,
     download the Pyodide release, put it in assets/vendor/pyodide/ and use
     'assets/vendor/pyodide/' here (see README). */
  pyodideBase: 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/',

  /* The WebAssembly bioinformatics programs (minimap2, samtools, bcftools, htslib). */
  biowasmBase: 'assets/vendor/biowasm',

  /* AI assistant: the default mode for new visitors ('guided' or 'live').
     Live mode needs an API key that each user enters in the assistant's settings.
     Never put an API key in this file – anyone could copy it from a public site. */
  assistantDefaultMode: 'guided',

  /* Live mode: the service offered first ('gemini', 'anthropic' or 'openai') and the
     model of each. Google's Gemini API has a free tier (a key from aistudio.google.com/apikey).
     Models are retired from time to time: if live mode reports that a model is not found,
     put a current one here (see ai.google.dev/gemini-api/docs/models). */
  liveProvider: 'gemini',
  geminiModel: 'gemini-3.8-flash',
  /* If that model is busy ("high demand", HTTP 503), over its free-tier limit (429) or not
     found (404), live mode asks these models in turn; the answer says which one replied.
     [] turns this off. */
  geminiFallbackModels: ['gemini-3.6-flash', 'gemini-3.5-flash-lite'],
  anthropicModel: 'claude-sonnet-5-5'
};
