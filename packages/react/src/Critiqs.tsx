import { useEffect, useRef } from "react";
import type { CritiqsProps } from "./host.ts";
import { type CritiqsInstance, mountCritiqs } from "./mount.tsx";

/**
 * Critiqs's one component. Add it anywhere in the prototype; it renders its
 * toolbar, sidebar, and pins above the app in a shadow root, with its own
 * sign-in, backend connection, and styles. It renders nothing in place.
 * With `requireProjectId`, it adds nothing to the page until `projectId` is a
 * valid project ID, and removes everything it added when the ID goes away.
 */
export function Critiqs(props: CritiqsProps) {
  const instance = useRef<CritiqsInstance | null>(null);

  useEffect(() => {
    if (instance.current === null) instance.current = mountCritiqs(props);
    else instance.current.update(props);
  });

  useEffect(
    () => () => {
      instance.current?.destroy();
      instance.current = null;
    },
    [],
  );

  return null;
}
