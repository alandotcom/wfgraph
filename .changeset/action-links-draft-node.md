---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

A host action can link the editor to a page of the host's own, and that page can read the node it was opened for.

`defineAction` takes `links: [{ label, url }]`. The editor lists them in Canvas Reveal for the selected node, at Browse and at Focus, and opens each in a new tab, writing the open workflow's id and the node's id into the url's `{workflowId}` and `{nodeId}` placeholders. A url is an absolute path starting with `/` or a URL starting `http://` or `https://`, with no control character and with a placeholder only in the path, query or fragment, and `defineAction` throws at startup for any other url, a blank label, or a label another link of the same action already has. Following a link starts a save of any edit still waiting on autosave.

`app.workflows.readDraftNode({ workflowId, nodeId })`, also on `createWfGraphRunner`, answers one node of the saved draft, or `null` when the workflow or node does not exist. The answer holds the node's label, action id and draft revision, and for a node running a host action, one field per input the action declares and the node stores, read the way the engine reads it: a template split into text and step or Entity references, the rows of a `key-value` field with each row's value split the same way, or a value handed to the step as stored, such as a number or a `literal` field. Any other node answers no fields. It applies no `auth`, so a host page authorizes the reader first. `workflows` is a new required member of the `WfGraphApp` type, so a host that builds its own object of that type around `createWfGraphApp`, for example to wrap `fetch` or `dispose`, must forward `workflows` as well or fail to type-check. Together they let a host build a page such as an email preview. See "Action links and draft reads" in `docs/embedding.md`.
