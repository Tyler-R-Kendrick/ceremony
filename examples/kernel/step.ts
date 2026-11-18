/**
 * One ceremony step as a UI SDK primitive: the behaviour of an interface the
 * kernel asks for, with no markup and no framework. A step takes one answer;
 * after that its controls are off until the next request replaces it.
 */
import { definePrimitive } from "@ui-sdk/core";

export interface StepAnswer {
  readonly action: string;
  readonly fields: Readonly<Record<string, string>>;
}

interface StepOptions {
  onAnswer?: (answer: StepAnswer) => void;
}

interface StepState {
  fields: Record<string, string>;
  answered: boolean;
}

export const ceremonyStep = definePrimitive({
  name: "ceremony-step",
  options: { onAnswer: "callback" },
  state: (_options: StepOptions): StepState => ({
    fields: {},
    answered: false,
  }),
  api: (context) => ({
    setField(name: string, value: string): void {
      if (context.store.get().answered) return;
      context.store.set({
        fields: { ...context.store.get().fields, [name]: value },
      });
    },
    answer(action: string): void {
      if (context.store.get().answered) return;
      context.store.set({ answered: true });
      context.options().onAnswer?.({
        action,
        fields: context.store.get().fields,
      });
    },
    isAnswered: (): boolean => context.store.get().answered,
  }),
  slots: (slot) => ({
    root: slot({
      attrs: (state: StepState) =>
        state.answered ? { "data-answered": "" } : {},
    }),
    field: slot<{ name: string }>({
      props: { name: "string" },
      attrs: (state: StepState) => (state.answered ? { disabled: "" } : {}),
      on: {
        input: (event, { api, props }) =>
          api.setField(props.name, (event.target as HTMLInputElement).value),
      },
    }),
    action: slot<{ value: string }>({
      props: { value: "string" },
      attrs: (state: StepState) =>
        state.answered ? { type: "button", disabled: "" } : { type: "button" },
      press: ({ api, props }) => api.answer(props.value),
    }),
  }),
  agent: { actions: ["answer", "setField"] },
});
