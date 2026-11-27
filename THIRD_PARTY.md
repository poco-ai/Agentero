# Third-party source notices

## tesseract-rs

`Cargo.toml` pins `tesseract-rs` to a fixed revision of
`poco-ai/tesseract-rs` through `[patch.crates-io]`. It is upstream 0.4.2 plus
one build fix: when security software blocks the build script's cache copy
into the install directory, keep a byte-identical installed library instead of
rebuilding into the same blocked path. Remove the patch once that change lands
upstream.

## Better Auth UI

The retained avatar component in `src/features/account/primitives/avatar.tsx`
derives from Better Auth UI 1.7.32's Base UI example at revision
`25c6b5e3a8b6b1e35153bd164d0d109b194c4eb3`:
https://github.com/better-auth-ui/better-auth-ui/tree/25c6b5e3a8b6b1e35153bd164d0d109b194c4eb3/examples/start-shadcn-baseui-example/src

The old local account and organization screens have been removed; account
management opens the Web application. Preserve this attribution when updating
the retained copied source.

MIT License

Copyright (c) 2025 daveycodez

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
