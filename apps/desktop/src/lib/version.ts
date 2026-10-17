// The app's version, from the one place it is set (tauri.conf.json and Cargo.toml say the same).
export { version as APP_VERSION } from "../../package.json";

/** Where every version is published (also the page to download one by hand). */
export const RELEASES_URL = "https://github.com/hostealo-org/hostealo-terminal/releases";
