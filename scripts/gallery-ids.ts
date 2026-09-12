/**
 * The two element ids the published catalogue's resolver hangs on.
 *
 * Shared by the page generator and by the script that runs in the browser,
 * because they are the seam between them: if the mount the page writes and the
 * mount the script looks for ever drift apart, the section renders as an empty
 * box with no error anywhere — a page that looks finished and does nothing.
 * A constant cannot drift, so there is nothing here to keep in step by hand.
 *
 * Deliberately free of imports: this file is reached from the browser bundle,
 * and anything it pulled in would be pulled in there too.
 */
export const resolverMountId = "resolver";
export const resolverPayloadId = "catalogue-data";
