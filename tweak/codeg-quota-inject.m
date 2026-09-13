// codeg-opencode-quota: 向 codeg 桌面版所有 WKWebView 注入额度药丸前端。
// 编译: clang -fobjc-arc -dynamiclib -framework Foundation -framework WebKit \
//         -install_name @rpath/libcodegquota.dylib -o libcodegquota.dylib codeg-quota-inject.m
// 加载: codeg.app Info.plist LSEnvironment.DYLD_INSERT_LIBRARIES（见 codeg-opencode-quota-repair）
#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

static NSString *CodegQuotaJSFile(void) {
    NSString *env = NSProcessInfo.processInfo.environment[@"CODEG_QUOTA_JS_FILE"];
    if (env.length) {
        return env;
    }
    return [NSHomeDirectory() stringByAppendingPathComponent:
            @".local/share/codeg-opencode-quota/opencode-quota.js"];
}

@implementation WKWebView (CodegQuotaInject)

+ (void)load {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        Method orig = class_getInstanceMethod(self, @selector(initWithFrame:configuration:));
        Method mine = class_getInstanceMethod(self, @selector(cq_initWithFrame:configuration:));
        if (orig && mine) {
            method_exchangeImplementations(orig, mine);
        }
    });
}

- (instancetype)cq_initWithFrame:(CGRect)frame configuration:(WKWebViewConfiguration *)configuration {
    @try {
        NSString *js = [NSString stringWithContentsOfFile:CodegQuotaJSFile()
                                                 encoding:NSUTF8StringEncoding
                                                    error:NULL];
        if (js.length && configuration.userContentController) {
            WKUserScript *script = [[WKUserScript alloc]
                    initWithSource:js
                     injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                  forMainFrameOnly:YES];
            [configuration.userContentController addUserScript:script];
        }
    } @catch (NSException *e) {
        // 注入失败不能影响宿主 app 启动
    }
    return [self cq_initWithFrame:frame configuration:configuration];
}

@end
