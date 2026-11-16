# Vendored third-party code

The web UI has no build step and makes no network requests other than to the Harness API, so the few
libraries it uses are copied here verbatim from their npm packages (dist files only). Each directory
keeps the package's original `LICENSE` file.

| Library | Version | npm package / file | License | Used for |
|---|---|---|---|---|
| marked | 18.2.0 | `marked` → `lib/marked.esm.js` | MIT | Markdown → HTML |
| DOMPurify | 3.4.18 | `dompurify` → `dist/purify.es.mjs` | Apache-2.0 OR MPL-2.0 | Sanitizing all rendered model output |
| highlight.js | 11.12.0 | `@highlightjs/cdn-assets` → `es/highlight.min.js` ("common" language bundle, ~36 languages) | BSD-3-Clause | Code syntax highlighting (themes are our own CSS, see `css/chat.css`) |

The only modification is that the trailing `//# sourceMappingURL=…` comment was removed from
`marked.esm.js` and `purify.es.mjs` (the `.map` files are not shipped).

To update: `npm pack <name>@<version>` in a temporary directory, copy the files listed above, remove
the source-map comment, and update this table.

SHA-256 of the shipped files:

```
7770f5e7c24ef750b366852b3c8a0ad846fcc404cd01831e328f365d7f7ca162  marked/marked.esm.js
f1f1ba66e2951e5ca14bc4e71e24cc503d35d49c68f9bcfa4fd97970cb71c76b  dompurify/purify.es.mjs
1ed8fc5256b738b8875b74e4d3f0754f60d6411fb034d618dfbc4e6e6c9999d7  highlight/highlight.min.js
```

Icons are drawn for Harness (`js/lib/icons.js`) and are not third-party.
