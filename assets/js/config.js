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
  /* If that model is busy ("high demand", HTTP 503), over a limit (429), not found (404) or
     gives no answer, live mode asks these models in turn; the answer says which one replied.
     The page remembers a model that could not answer and does not ask it again at once.
     On the free tier every model has limits of its own, per minute and per day, so a longer
     list gives a free key more requests in a day: put the models first that you would rather
     have. [] turns this off. (All of these answered a free key on 6 October 2026.) */
  geminiFallbackModels: ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  /* How many seconds a Gemini model may say nothing – before its answer begins, or in the
     middle of it – until the page gives that request up and asks the next model. */
  aiWaitSeconds: 60,
  anthropicModel: 'claude-sonnet-5-5',

  /* The real agent of chapter 8 (live mode): after how many seconds a step that has not
     ended is stopped. (150; at least 5.) */
  agentCommandSeconds: 150
};
