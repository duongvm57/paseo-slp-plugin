export const clipboardState = { copy: async () => {} };
export function copyText(text) { return clipboardState.copy(text); }

export { ScrollView, TextInput } from './rn-stub.mjs';
import React from 'react';
export function Icon(props) { return React.createElement('Icon', props); }
export function Modal(props) { return props.open ? React.createElement('Modal', props, props.children) : null; }
Modal.Content = props => React.createElement('ModalContent', props, props.children);
