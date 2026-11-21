// Tests: shell tabs / history / bookmarks.
import test from "node:test";
import assert from "node:assert/strict";
import { BookmarkManager, TabManager, createMemoryShellStore } from "../src/lib/shell.js";

test("TabManager starts with a home tab; open/navigate/back/forward work", async () => {
  const tabs = new TabManager(createMemoryShellStore());
  await tabs.load();
  assert.equal(tabs.list().length, 1);
  assert.equal(tabs.active()?.address, "home");
  assert.equal(tabs.canBack(), false);

  await tabs.open("arknetz://welcome.arknetz", "Welcome");
  assert.equal(tabs.list().length, 2);
  await tabs.navigate("arknetz://computers.edu", "Computers");
  assert.equal(tabs.active()?.address, "arknetz://computers.edu");
  assert.equal(tabs.canBack(), true);
  assert.equal(tabs.canForward(), false);

  await tabs.back();
  assert.equal(tabs.active()?.address, "arknetz://welcome.arknetz");
  assert.equal(tabs.canForward(), true);
  await tabs.forward();
  assert.equal(tabs.active()?.address, "arknetz://computers.edu");
});

test("back at the start of history is a no-op; forward past the end is a no-op", async () => {
  const tabs = new TabManager(createMemoryShellStore());
  await tabs.load();
  await tabs.back();
  assert.equal(tabs.active()?.address, "home");
  await tabs.forward();
  assert.equal(tabs.active()?.address, "home");
});

test("navigating after going back truncates forward history", async () => {
  const tabs = new TabManager(createMemoryShellStore());
  await tabs.load();
  await tabs.navigate("arknetz://a.zine");
  await tabs.navigate("arknetz://b.zine");
  await tabs.back();
  await tabs.navigate("arknetz://c.zine");
  assert.equal(tabs.canForward(), false);
  await tabs.back();
  assert.equal(tabs.active()?.address, "arknetz://a.zine");
});

test("closing the last tab recreates a home tab", async () => {
  const tabs = new TabManager(createMemoryShellStore());
  await tabs.load();
  const id = tabs.active()?.id as string;
  await tabs.close(id);
  assert.equal(tabs.list().length, 1);
  assert.equal(tabs.active()?.address, "home");
});

test("BookmarkManager adds, dedupes, lists, and removes", async () => {
  const bm = new BookmarkManager(createMemoryShellStore());
  await bm.load();
  await bm.add("arknetz://computers.edu", "Computers");
  await bm.add("arknetz://computers.edu", "Computers");
  assert.equal(bm.list().length, 1);
  assert.equal(bm.isBookmarked("arknetz://computers.edu"), true);
  await bm.remove("arknetz://computers.edu");
  assert.equal(bm.list().length, 0);
  assert.equal(bm.isBookmarked("arknetz://computers.edu"), false);
});
