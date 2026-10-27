import { network } from "../networks/network";

/** What a view says when the feed could not be read and it holds nothing older. */
export const FEED_UNREADABLE_TEXT = `Der ${network.operator.name}-Feed konnte nicht gelesen werden.`;
