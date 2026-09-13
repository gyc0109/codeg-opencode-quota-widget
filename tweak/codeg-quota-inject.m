// codeg-opencode-quota: 向 codeg 桌面版 WKWebView 注入额度药丸前端。
//
// 设计要点（务必保持，否则会拖累整机）：
//  1. 只对 codeg 主进程生效。DYLD_INSERT_LIBRARIES 会被 codeg 的所有子进程继承
//     （node/python/agent 等），若不做限定，每个子进程都会被拖入我们的逻辑。
//  2. 编译期不链接 WebKit。类通过运行时查找，只有确认是 codeg 主进程才主动 dlopen，
//     子进程里本 dylib 只多加载 Foundation（共享缓存，代价极小）。
//  3. 同一个 WKWebViewConfiguration 只注入一次（associated object 去重）。
//
// 编译: clang -fobjc-arc -dynamiclib -framework Foundation \
//         -install_name @rpath/libcodegquota.dylib -o libcodegquota.dylib codeg-quota-inject.m
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <dlfcn.h>
#include <stdlib.h>
#include <string.h>

static NSString *CodegQuotaJSFile(void) {
    const char *env = getenv("CODEG_QUOTA_JS_FILE");
    if (env && env[0]) {
        return [NSString stringWithUTF8String:env];
    }
    return [NSHomeDirectory() stringByAppendingPathComponent:
            @".local/share/codeg-opencode-quota/opencode-quota.js"];
}

// 仅在 codeg 主进程里工作；子进程（继承到 DYLD_INSERT_LIBRARIES 的各类工具）直接放行。
// CODEG_QUOTA_FORCE=1 供测试宿主使用。
static BOOL IsCodegMainProcess(void) {
    const char *force = getenv("CODEG_QUOTA_FORCE");
    if (force && force[0] && strcmp(force, "0") != 0) {
        return YES;
    }
    NSString *exe = NSBundle.mainBundle.executablePath;
    return exe && [exe hasSuffix:@"/Contents/MacOS/codeg"];
}

// 进程内缓存 js 源码，避免每次建 webview 都读盘
static NSString *QuotaJS(void) {
    static NSString *js;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        js = [NSString stringWithContentsOfFile:CodegQuotaJSFile()
                                       encoding:NSUTF8StringEncoding
                                          error:NULL];
    });
    return js;
}

static void InjectIntoConfiguration(id configuration) {
    if (!configuration) {
        return;
    }
    static char injectedKey;
    if (objc_getAssociatedObject(configuration, &injectedKey)) {
        return;  // 同一 configuration 复用多个 webview 时只注入一次
    }
    @try {
        NSString *js = QuotaJS();
        Class scriptCls = NSClassFromString(@"WKUserScript");
        SEL uccSel = NSSelectorFromString(@"userContentController");
        if (!js.length || !scriptCls || ![configuration respondsToSelector:uccSel]) {
            return;
        }
        id ucc = ((id (*)(id, SEL))objc_msgSend)(configuration, uccSel);
        SEL initSel = NSSelectorFromString(@"initWithSource:injectionTime:forMainFrameOnly:");
        IMP initImp = class_getMethodImplementation(scriptCls, initSel);
        if (!ucc || !initImp) {
            return;
        }
        // injectionTime 0 = WKUserScriptInjectionTimeAtDocumentStart
        id script = ((id (*)(id, SEL, id, NSInteger, BOOL))initImp)(
            [scriptCls alloc], initSel, js, 0, YES);
        if (!script) {
            return;
        }
        ((void (*)(id, SEL, id))objc_msgSend)(
            ucc, NSSelectorFromString(@"addUserScript:"), script);
        objc_setAssociatedObject(configuration, &injectedKey, @YES, OBJC_ASSOCIATION_RETAIN);
    } @catch (NSException *e) {
        // 注入失败不能影响宿主 app
    }
}

__attribute__((constructor)) static void CodegQuotaInit(void) {
    if (!IsCodegMainProcess()) {
        return;  // 子进程：什么都不做
    }
    if (!NSClassFromString(@"WKWebView")) {
        // codeg 必然链接 WebKit（wry 依赖）；此处兜底确保类可用
        dlopen("/System/Library/Frameworks/WebKit.framework/WebKit", RTLD_LAZY);
    }
    Class cls = NSClassFromString(@"WKWebView");
    SEL sel = NSSelectorFromString(@"initWithFrame:configuration:");
    Method method = cls ? class_getInstanceMethod(cls, sel) : NULL;
    if (!method) {
        return;
    }
    IMP orig = method_getImplementation(method);
    IMP hook = imp_implementationWithBlock(^id(id self_, CGRect frame, id configuration) {
        InjectIntoConfiguration(configuration);
        return ((id (*)(id, SEL, CGRect, id))orig)(self_, sel, frame, configuration);
    });
    method_setImplementation(method, hook);
}
