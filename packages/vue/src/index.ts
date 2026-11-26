// Critiqs for Vue: a component that adds Critiqs above the app and renders
// nothing itself. Critiqs's interface comes from the shared `critiqs` package,
// loaded in the browser once the component is mounted, so server rendering
// (Nuxt, Vite SSR) never runs it and the app's own bundle stays small.
import type { CritiqsInstance, CritiqsOptions } from "critiqs";
import { defineComponent, getCurrentInstance, onBeforeUnmount, onMounted, type PropType, watch } from "vue";
import { followRouter, routerRestore, usableRouter } from "./router.ts";

export type { CritiqsInstance, CritiqsOptions, HostContext, RestoreRequest, Scope, ViewState } from "critiqs";
/**
 * Elements with this attribute are covered in captures. The shared package's
 * value, kept here so importing it doesn't load Critiqs into the app's bundle.
 */
export const MASK_ATTRIBUTE = "data-critiqs-mask";
/** The `<Critiqs>` component's properties: `CritiqsOptions`, plus `router` to turn Vue Router integration off. */
export type CritiqsProps = CritiqsOptions & { router?: boolean };

/**
 * Adds Critiqs's toolbar, sidebar, and pins to the page. Put it once in the
 * root component, such as App.vue:
 *
 * ```vue
 * <Critiqs :project-id="projectId" require-project-id />
 * ```
 *
 * With Vue Router, each route is reported as the screen (`users/:id`) and a
 * thread's route is shown again with `router.push`, unless `:router="false"`.
 * Changing a property updates Critiqs; unmounting the component removes it.
 */
export const Critiqs = defineComponent({
  name: "Critiqs",
  props: {
    projectId: { type: String, default: undefined },
    requireProjectId: { type: Boolean, default: false },
    backend: { type: String, default: undefined },
    version: { type: String, default: undefined },
    getContext: { type: Function as PropType<CritiqsOptions["getContext"]>, default: undefined },
    restoreContext: { type: Function as PropType<CritiqsOptions["restoreContext"]>, default: undefined },
    router: { type: Boolean, default: true },
  },
  setup(props) {
    const router = usableRouter(getCurrentInstance()?.appContext.config.globalProperties.$router);
    let instance: CritiqsInstance | null = null;
    let stopFollowing: (() => void) | null = null;
    let defaultRestore: CritiqsOptions["restoreContext"];
    let loading = false;
    let mounted = false;
    let unmounted = false;

    const routed = () => props.router && router !== null;
    const options = (): CritiqsOptions => {
      const { projectId, requireProjectId, backend, version, getContext, restoreContext } = props;
      // The app's own restoreContext replaces navigating with the router.
      const restore = restoreContext ?? (routed() ? (defaultRestore ??= routerRestore(router!)) : undefined);
      return { projectId, requireProjectId, backend, version, getContext, restoreContext: restore };
    };
    // With requireProjectId and no ID, Critiqs would add nothing, so the
    // browser doesn't download it until an ID arrives.
    const wanted = () => !props.requireProjectId || (props.projectId ?? "").trim() !== "";
    const follow = () => {
      if (instance === null) return;
      if (routed() && stopFollowing === null) stopFollowing = followRouter(router!, instance);
      else if (!routed() && stopFollowing !== null) {
        stopFollowing();
        stopFollowing = null;
        instance.setContext({});
      }
    };

    const sync = async () => {
      if (instance !== null) {
        instance.update(options());
        return follow();
      }
      if (!mounted || loading || !wanted()) return;
      loading = true;
      try {
        const shared = await import("critiqs");
        if (unmounted) return;
        // Settings read after loading, so changes made meanwhile apply.
        instance = shared.mountCritiqs(options());
        follow();
      } finally {
        loading = false;
      }
    };

    onMounted(() => {
      mounted = true;
      return sync();
    });
    // A new object on every read, so any property change runs sync, including
    // a new function passed to getContext or restoreContext. Before mounting
    // (a suspended or server render), sync loads nothing.
    watch(() => ({ ...props }), sync);
    onBeforeUnmount(() => {
      unmounted = true;
      stopFollowing?.();
      stopFollowing = null;
      instance?.destroy();
      instance = null;
    });
    return () => null;
  },
});
