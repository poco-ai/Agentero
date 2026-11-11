/* Opt-in Linux JSC regression runner; see pdf-webkit-async-page-state.md. */
#define _GNU_SOURCE
#include <JavaScriptCore/JavaScript.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>

extern void JSLock(JSContextRef);
extern void JSUnlock(JSContextRef);

static int evaluate(JSGlobalContextRef context, const char *source) {
    JSStringRef script = JSStringCreateWithUTF8CString(source);
    JSValueRef error = NULL;
    JSEvaluateScript(context, script, NULL, NULL, 1, &error);
    JSStringRelease(script);
    if (!error) return 0;
    JSStringRef text = JSValueToStringCopy(context, error, NULL);
    size_t size = JSStringGetMaximumUTF8CStringSize(text);
    char *message = malloc(size);
    JSStringGetUTF8CString(text, message, size);
    fprintf(stderr, "%s\n", message);
    free(message);
    JSStringRelease(text);
    return 1;
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "Usage: reflow-webkit-runner <bundled-test.js>\n");
        return 2;
    }
    void (*delete_code)(void *, int) = dlsym(
        RTLD_DEFAULT, "_ZN3JSC2VM13deleteAllCodeENS_19DeleteAllCodeEffortE");
    if (!delete_code) {
        fprintf(stderr, "This JavaScriptCore does not expose deleteAllCode\n");
        return 2;
    }
    FILE *file = fopen(argv[1], "rb");
    if (!file) { perror(argv[1]); return 2; }
    fseek(file, 0, SEEK_END);
    long size = ftell(file);
    if (size < 0) { fclose(file); return 2; }
    rewind(file);
    char *source = calloc((size_t)size + 1, 1);
    if (!source) { fclose(file); return 2; }
    if (fread(source, 1, size, file) != (size_t)size) {
        free(source); fclose(file); return 2;
    }
    fclose(file);

    JSGlobalContextRef context = JSGlobalContextCreate(NULL);
    int failed = evaluate(context,
        "globalThis.queue = []; globalThis.global = globalThis;"
        "globalThis.setTimeout = callback => queue.push(callback);");
    if (!failed) failed = evaluate(context, source);
    free(source);
    if (!failed) {
        /* The async extractor is suspended; reproduce memory-pressure relinking. */
        JSLock(context);
        delete_code((void *)JSContextGetGroup(context), 0);
        JSUnlock(context);
        for (int i = 0; i < 2000 && !failed; i++)
            failed = evaluate(context, "if (queue.length) queue.shift()();");
        if (!failed) failed = evaluate(context,
            "if (!globalThis.reflowCheckDone) throw new Error('Extraction incomplete');"
            "if (globalThis.reflowCheckError) throw new Error(globalThis.reflowCheckError);");
    }
    JSGlobalContextRelease(context);
    if (!failed) puts("PASS: page character counts and fonts survive JSC code collection");
    return failed;
}
