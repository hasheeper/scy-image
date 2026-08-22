import assert from "node:assert/strict";
import { convertToNaiPrompt } from "../docs/js/prompt-converter.js";

const source = String.raw`1girl, solo, catgirl, light\_blue\_hair, ((light\_blue\_skirt)), (bloomers:0.9), yellow eyes,\
&#x20;white\_leg\_warmers,

()`;

assert.equal(
  convertToNaiPrompt(source),
  "1girl, solo, catgirl, light blue hair, 1.21::light blue skirt::, 0.9::bloomers::, yellow eyes,\nwhite leg warmers"
);
assert.equal(convertToNaiPrompt(String.raw`sho\_(sho\_lwlw)`), "sho (sho lwlw)");
assert.equal(convertToNaiPrompt(String.raw`artist\_(foo:bar)`), "artist (foo:bar)");
assert.equal(convertToNaiPrompt("rossi (arknights)"), "rossi (arknights)");
assert.equal(convertToNaiPrompt(String.raw`(sho\_(sho\_lwlw))`), "1.1::sho (sho lwlw)::");
assert.equal(convertToNaiPrompt("(tag)"), "1.1::tag::");
assert.equal(convertToNaiPrompt("((tag))"), "1.21::tag::");
assert.equal(convertToNaiPrompt("(tag:0.9)"), "0.9::tag::");
assert.equal(convertToNaiPrompt("((tag:0.9))"), "0.99::tag::");
assert.equal(convertToNaiPrompt("(red_hair, blue_eyes:1.2)"), "1.2::red hair, blue eyes::");
assert.equal(convertToNaiPrompt("1.2::blue_hair::"), "1.2::blue hair::");
assert.equal(convertToNaiPrompt("(), blue_hair, ()"), "blue hair");
assert.equal(convertToNaiPrompt("blue_hair,\nwhite_dress"), "blue hair,\nwhite dress");
assert.equal(convertToNaiPrompt("blue_hair\nwhite_dress"), "blue hair\nwhite dress");
assert.equal(convertToNaiPrompt("a,\n\nb"), "a,\n\nb");

console.log("prompt converter tests passed");
