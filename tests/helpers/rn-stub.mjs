// react-native boundary stub for node:test renders — the hook tests render
// function components through react-test-renderer, never a native tree, so
// host components are inert placeholders that pass children through.
const inert = (name) => {
  const component = (props) => (props && props.children !== undefined ? props.children : null);
  component.displayName = name;
  return component;
};

export const Pressable = inert("Pressable");
export const ScrollView = inert("ScrollView");
export const Text = inert("Text");
export const TextInput = inert("TextInput");
export const View = inert("View");
export const StyleSheet = { create: (styles) => styles, hairlineWidth: 1 };
