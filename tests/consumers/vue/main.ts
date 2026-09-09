import { createApp, h, onMounted, onUnmounted, shallowRef } from "vue";
import {
  browserModelContext,
  createCeremonyClient,
  createHttpTransport,
  manifestSchema,
} from "@ceremony/auth";
import "@ceremony/auth/styles.css";

const config = await fetch("/api/config").then((response) => response.json());
const manifest = manifestSchema.parse(config.manifests[1]);
createApp({
  setup() {
    const client = createCeremonyClient({
      manifest,
      transport: createHttpTransport(),
    });
    const state = shallowRef(client.getState());
    const unsubscribe = client.subscribe(() => {
      state.value = client.getState();
    });
    onMounted(() => {
      const context = browserModelContext();
      if (context) client.attachWebMCP(context, "external_vue");
      void client.initialize().catch(() => {});
    });
    onUnmounted(() => {
      unsubscribe();
      client.dispose();
    });
    return () =>
      h(
        "section",
        { "data-ceremony": "", "aria-label": "Vue connection ceremony" },
        [
          h("h2", "Connect with Vue"),
          state.value.error
            ? h("p", { role: "alert" }, state.value.error)
            : null,
          state.value.snapshot?.step === "complete"
            ? h("p", "Vue connected")
            : state.value.snapshot?.actions.includes("submit")
              ? h(
                  "form",
                  {
                    onSubmit: (event: Event) => {
                      event.preventDefault();
                      const form = event.currentTarget;
                      if (!(form instanceof HTMLFormElement)) return;
                      const token = new FormData(form).get("token");
                      form.reset();
                      if (typeof token === "string")
                        void client
                          .execute({ action: "submit", values: { token } })
                          .catch(() => {});
                    },
                  },
                  [
                    h("label", { for: "vue-token" }, "Vue token"),
                    h("input", {
                      id: "vue-token",
                      name: "token",
                      type: "password",
                      required: true,
                      disabled: state.value.busy,
                    }),
                    h(
                      "button",
                      { type: "submit", disabled: state.value.busy },
                      "Connect from Vue",
                    ),
                  ],
                )
              : h("p", "Loading ceremony"),
        ],
      );
  },
}).mount("#root");
