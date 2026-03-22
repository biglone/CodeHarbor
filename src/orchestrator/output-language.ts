import type { OutputLanguage } from "../config";

export function byOutputLanguage<T>(language: OutputLanguage, zh: T, en: T): T {
  return language === "en" ? en : zh;
}

export function yesNoByOutputLanguage(language: OutputLanguage, value: boolean): string {
  return byOutputLanguage(language, value ? "是" : "否", value ? "yes" : "no");
}

export function onOffByOutputLanguage(language: OutputLanguage, value: boolean): string {
  return value ? "on" : "off";
}

export function naByOutputLanguage(language: OutputLanguage): string {
  return byOutputLanguage(language, "N/A", "N/A");
}

