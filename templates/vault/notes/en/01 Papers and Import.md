# Papers & Import

## Creating a Paper Library

## Import Methods

Agentero supports several ways to import papers into your Vault.

### Magic Wand

1. Click the magic-wand button in the sidebar.
2. Paste a link into the input field. Agentero downloads metadata and the PDF into a new paper folder.
   - arXiv IDs
   - DOIs
   - Website URLs, including blog posts

### Zotero Connector

The [Zotero Connector](https://www.zotero.org/download/connectors) is Zotero's official browser extension for Chrome, Firefox, Edge, and Safari. Once installed, one click on the extension icon saves the paper or webpage you are reading as an item.

1. Install the extension from [zotero.org/download/connectors](https://www.zotero.org/download/connectors)
2. Enable **Zotero Connector** in Settings → General.
3. Close the local Zotero application.
4. Click the extension icon in your browser to save items to the current Vault.

### Importing Webpages

To save a webpage you are reading (blog, docs, news, …), pick either way:

- **Magic Wand**: paste the page URL into the magic wand and Agentero fetches the content into a new paper folder.
- **Zotero Connector**: click the extension icon while browsing to save the page to the current Vault.

### Local PDF

Drag a PDF into the file tree, or use the import command to create a paper folder from a local file.

## Library

The Library table shows all papers in the catalog. You can:

- Sort by clicking column headers.
- Right-click a header to choose visible columns and reorder them.
- Filter by tags or search title, author, abstract, and tag substrings.
- Right-click the **papers/** library node and choose **Rescan papers/** to recover paper folders missing from the catalog. An empty library also offers a central Rescan button.

### Adding Tags

Add or remove tags in the **Info** panel at the bottom left. Tags are stored in `catalog.sqlite` and shown as colored chips in the Library.

## Next

- [[02 Agent and Skills]]
- [[03 Markdown and Wikilinks]]
