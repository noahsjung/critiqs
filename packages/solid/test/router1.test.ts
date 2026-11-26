// Solid 1.9 with Solid Router 1, as SolidStart 2 apps use them.
import { mock } from "bun:test";
import * as Solid from "solid-js-1";
import * as Store from "solid-js-1/store";
import * as Web from "solid-js-1/web";

mock.module("solid-js", () => Solid);
mock.module("solid-js/web", () => Web);
mock.module("solid-js/store", () => Store);
const Router = await import("solid-router-1");
mock.module("@solidjs/router", () => Router);
const { later, routesSuite } = await import("./routes.ts");

const PATTERNS = ["/", "/users/:id", "/files/*rest", "*404"];

routesSuite("Solid 1.9 with Router 1", {
  createComponent: Solid.createComponent as never,
  blockLeaving: () => Router.useBeforeLeave((event) => event.preventDefault()),
  mount(path, element, base) {
    const target = document.createElement("div");
    document.body.append(target);
    const history = Router.createMemoryHistory();
    if (path !== null) history.set({ value: path });
    const dispose = Web.render(
      () =>
        (path === null
          ? element()
          : Solid.createComponent(Router.MemoryRouter, {
              history,
              base,
              // As SolidStart's layout does, routes render under Suspense, so a route still loading holds the navigation.
              root: (props) => [element(), Solid.createComponent(Solid.Suspense, { get children() { return props.children; } })] as never,
              get children() {
                return [
                  ...PATTERNS.map((pattern) => Solid.createComponent(Router.Route, { path: pattern, component: () => pattern as never })),
                  Solid.createComponent(Router.Route, { path: "/slow", component: Solid.lazy(() => new Promise<never>(() => {})) }),
                  Solid.createComponent(Router.Route, { path: "/later", component: Solid.lazy(() => later.next(() => "later") as never) }),
                  // A layout route with a child: the screen is the child's whole pattern.
                  Solid.createComponent(Router.Route, {
                    path: "/team",
                    component: (props: { children?: unknown }) => props.children as never,
                    get children() {
                      return Solid.createComponent(Router.Route, { path: "/:member", component: () => "member" as never });
                    },
                  }),
                ];
              },
            })) as never,
      target,
    );
    return {
      go: (next) => history.set({ value: next }),
      back: () => history.back(),
      location: () => history.get(),
      dispose() {
        dispose();
        target.remove();
      },
    };
  },
});
