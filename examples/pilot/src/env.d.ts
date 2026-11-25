// Critiqs settings for the pilot, read from `.env.local`. Both are optional:
// without a project ID, Critiqs shows project setup in its sidebar.
interface ImportMetaEnv {
  readonly VITE_CRITIQS_BACKEND?: string;
  readonly VITE_CRITIQS_PROJECT_ID?: string;
}
