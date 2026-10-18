/** Strict XML decoding shared by the feed parsers and probe. Namespace prefixes are omitted. */
import { DOMParser, type Element } from "@xmldom/xmldom";

export type XmlElement = {
  name: string;
  children: XmlElement[];
  text: string;
};

function toElement(element: Element): XmlElement {
  const children: XmlElement[] = [];
  let text = "";
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === node.ELEMENT_NODE) children.push(toElement(node as Element));
    else if (node.nodeType === node.TEXT_NODE || node.nodeType === node.CDATA_SECTION_NODE) {
      text += node.nodeValue ?? "";
    }
  }
  return { name: element.localName ?? element.tagName, children, text };
}

export function parseXml(source: string): XmlElement {
  const document = new DOMParser({
    onError: (_level, message) => {
      throw new Error(message);
    },
  }).parseFromString(source, "application/xml");
  if (document.doctype || !document.documentElement) throw new Error("Unerwartetes XML-Dokument");
  return toElement(document.documentElement);
}

/** The direct children with this name. */
export const childrenNamed = (element: XmlElement | undefined, name: string): XmlElement[] =>
  element?.children.filter((child) => child.name === name) ?? [];

/** Follows a path of direct children; `undefined` where a step is missing. */
export function child(element: XmlElement | undefined, ...path: string[]): XmlElement | undefined {
  let current = element;
  for (const name of path) current = current?.children.find((entry) => entry.name === name);
  return current;
}

/** All elements with this name below `element`, at any depth, in document order. */
export function descendantsNamed(element: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  const visit = (parent: XmlElement) => {
    for (const entry of parent.children) {
      if (entry.name === name) found.push(entry);
      else visit(entry);
    }
  };
  visit(element);
  return found;
}

/** The trimmed text at a path of direct children; `undefined` where missing or empty. */
export function textAt(element: XmlElement | undefined, ...path: string[]): string | undefined {
  const value = child(element, ...path)?.text.trim();
  return value ? value : undefined;
}
