# Your data and privacy

What RAG Playground keeps, where it keeps it and for how long. There are no accounts and
no sign in. This page says the same as the **Your data and privacy** page in the app
([on the demo](https://nadeem4nk-rag-playground.hf.space/privacy)), which also lets you
delete what is kept.

## In this browser

Kept on your device. The demo server sees only what a request needs: the pipeline settings
with a run, and a question set while it is checked.

| What | Where | How long |
|---|---|---|
| Saved pipelines and experiments | In this browser's storage | Until you delete them on the privacy page or clear this site's data. They never leave this browser unless you export them or share a link. |
| The pipeline you are working on | In this browser's storage | Until you change it. It is how Build, Compare and Evaluate share one pipeline. |
| Theme and contrast | In this browser's storage | Until you change them. |
| Where the Ask panel sits on Build | In this browser's storage | Its side, its width and whether it is open, until you change them. |
| Page images you viewed | In this browser's cache | They may stay in this browser's cache until it is cleared, even after the upload they show is deleted. |
| A question set you upload for Evaluate | On the demo: in this tab only. Locally: on this machine, beside the document. | On the demo: until you close the tab. The demo checks the set and keeps nothing. Locally: until you delete it. |
| Your last evaluation, for the before and after | In this tab only | Until you close the tab. |
| API keys you add | In this tab's memory only | Until you close or reload the tab. A key is sent with each request that needs it and is never written to storage, a cookie, a link or a saved file. |

## On the demo server

| What | Where | How long |
|---|---|---|
| PDFs you upload | On the demo server, private to this browser | 24 hours, then deleted. At most 3 files at a time, 10 MB and 20 pages each. |
| An anonymous browser id | A cookie named `rag_visitor` | One year. It only links your uploads to this browser. It holds no name, email or account. |
| Run results (pieces, indexes, answers) | On the demo server, as a cache shared by recipe | So a repeat run is quick. Nothing deletes them on a timer, not even when the upload they came from is deleted. They stay until the demo restarts or the cache is cleared, since the demo runs without persistent storage. |

## On your machine

When you run RAG Playground yourself with demo mode off:

| What | Where | How long |
|---|---|---|
| PDFs you upload | In the project's `sources` folder | Until you delete them. Nothing expires on your machine. |
| An anonymous browser id | A cookie named `rag_visitor` | One year. On your machine it only marks which browser uploaded a file. |
| Run results | In the project's `artifacts` folder, as a cache | Until you clear the cache. |

This copy runs on your machine, so what you add stays on it, except calls to a model
provider when you add a key. The folders can be moved with environment variables; see
[deploy.md](deploy.md#variables-and-secrets).

## What is never kept

- Your API keys, anywhere.
- Your name or email. There is nothing to sign in to.
- On the demo: another visitor's uploads in your view, or yours in theirs. Locally:
  anything on a server of ours.

The demo runs on Hugging Face Spaces, so their
[privacy policy](https://huggingface.co/privacy) and
[terms](https://huggingface.co/terms-of-service) cover the hosting itself.

## What goes to a model provider

When you run it yourself, nothing leaves your machine except the model downloads from
Hugging Face and, when you use the chat answer, the LLM reranker or the LLM rewrite, the
text that step sends to the provider you chose. The same steps send the same text from
the demo server.
See [models-and-keys.md](models-and-keys.md#what-happens-to-a-key).

## Clean up now

The privacy page in the app has three buttons:

- **Delete saved pipelines and experiments** deletes them in this browser. It cannot be
  undone, so export them first in Library if you may want them later.
- **Delete my uploads from the demo** (on the demo only) deletes your uploads now, instead
  of after 24 hours. Saved items that use them stay, and ask for the PDF again when opened.
- **Export first, in Library** opens the Library.

It asks on the page before deleting anything.
