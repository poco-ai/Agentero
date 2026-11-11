# Third-party source notices

## tesseract-rs

`patches/tesseract-rs` is tesseract-rs 0.2.0, vendored so its build-time
Tesseract source download uses the patched `zip` 9 line instead of the
upstream `zip = "2"` (GHSA-m665-v7pm-7grj). The only source change is the
`mangled_name()` result unwrap in `build.rs`.

It lives alongside the other local dependency fixes in `patches/`. Cargo's
root `[patch.crates-io]` points to this complete crate; it is excluded from
the workspace members. The crate's upstream README and MIT license are retained.

MIT License

Copyright (c) 2024 Cafer Can Gündoğdu

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
