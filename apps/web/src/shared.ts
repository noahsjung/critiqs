// Every piece this app reuses from critiqs-react's source, read-only, in one
// place. critiqs-react publishes only its built component, so these come from
// packages/react/src directly; another team owns those files.

export { HOSTED_BACKEND_URL, resolveDeployment, type Deployment } from "../../../packages/react/src/deployment.ts";
export { Session, SignInError, type Reviewer } from "../../../packages/react/src/session.ts";
export { STYLES } from "../../../packages/react/src/styles.ts";
export { Select, StepDots } from "../../../packages/react/src/ui/ds.tsx";
export { BackIcon } from "../../../packages/react/src/ui/icons.tsx";
export { convexClient } from "../../../packages/react/src/convex/client.ts";
export { useAllPages, useQueryState } from "../../../packages/react/src/convex/queries.ts";
export { useUtcDay } from "../../../packages/react/src/hooks.ts";
export { describeError, type QueryState } from "../../../packages/react/src/transport.ts";
// The installed panel's thread pieces, for the thread page: avatars, times,
// and message text with its mentions and hashtags drawn as the panel draws them.
export { Avatar } from "../../../packages/react/src/ui/common.tsx";
export { fullTime, relativeTime } from "../../../packages/react/src/ui/format.ts";
export { MessageBody, tagDisplay } from "../../../packages/react/src/ui/MentionInput.tsx";
