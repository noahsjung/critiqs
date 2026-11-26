---
"critiqs-react": minor
---

Projects can keep an address list for the coming browser extension: origins such as `https://acme-proto.vercel.app`, or patterns such as `https://*-acme.vercel.app`, set by the project's owners. The extension will find a page's project by its origin, searching only projects in the person's organizations and projects they opened through an install; another team's project with the same origin is never shown or revealed. The installed component now records, once per page load, that the signed-in reviewer opened its project, on backends that report `addressLists` at `/critiqs/config`. The backend protocol stays 5: these are new calls (`projects:setAddresses`, `projects:addresses`, `projects:recordOpened`, `projects:findForOrigin` on Convex, and the same calls on the self-hosted server), and older components keep working unchanged. Deploy the matching backend; the self-hosted server's database moves to schema version 12 when it starts.
