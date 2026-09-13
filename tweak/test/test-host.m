// 最小 WKWebView 测试宿主：模拟 codeg 桌面壳（tauri://localhost 自定义协议 + 真实 :3081 数据面），
// 验证 dylib 注入的药丸能否渲染。用法见同目录 run-test.sh。
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

static NSString *const kMockHTML =
    @"<!DOCTYPE html><html><head><meta charset='utf-8'><title>codeg mock</title></head>"
     "<body style='font:14px -apple-system'><div style='padding:60px'>"
     "<div style='display:flex;gap:8px'><div class='group/cmd'>"
     "<button>＋ 添加命令</button></div></div></div></body></html>";

@interface MockSchemeHandler : NSObject <WKURLSchemeHandler>
@end

@implementation MockSchemeHandler
- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    NSData *data = [kMockHTML dataUsingEncoding:NSUTF8StringEncoding];
    NSHTTPURLResponse *resp = [[NSHTTPURLResponse alloc]
        initWithURL:task.request.URL statusCode:200 HTTPVersion:@"HTTP/1.1"
        headerFields:@{@"Content-Type": @"text/html; charset=utf-8",
                       @"Access-Control-Allow-Origin": @"*"}];
    @try {
        [task didReceiveResponse:resp];
        [task didReceiveData:data];
        [task didFinish];
    } @catch (NSException *e) { /* task cancelled */ }
}
- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task {}
@end

@interface AppDelegate : NSObject <NSApplicationDelegate>
@property(strong) NSWindow *window;
@property(strong) WKWebView *webView;
@end

@implementation AppDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)note {
    WKWebViewConfiguration *cfg = [[WKWebViewConfiguration alloc] init];
    [cfg setURLSchemeHandler:[[MockSchemeHandler alloc] init] forURLScheme:@"tauri"];
    self.webView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 1000, 700) configuration:cfg];
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 1000, 700)
                                             styleMask:NSWindowStyleMaskTitled
                                               backing:NSBackingStoreBuffered
                                                 defer:NO];
    self.window.contentView = self.webView;
    [self.window makeKeyAndOrderFront:nil];
    [self.webView loadRequest:[NSURLRequest requestWithURL:
        [NSURL URLWithString:@"tauri://localhost/index.html"]]];

    // CODEG_QUOTA_TEST_OPEN=1：3 秒时自动点开药丸（弹层截图用）
    // CODEG_QUOTA_TEST_TAB=src:cc-switch 可先切到指定 tab
    if (getenv("CODEG_QUOTA_TEST_OPEN")) {
        const char *tab = getenv("CODEG_QUOTA_TEST_TAB");
        if (tab && tab[0]) {
            NSString *js = [NSString stringWithFormat:
                @"localStorage.setItem('opencode-quota-provider','%s')",
                tab];
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2.5 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{
                [self.webView evaluateJavaScript:js completionHandler:nil];
            });
        }
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            [self.webView evaluateJavaScript:
                @"document.getElementById('opencode-quota-inline').click()"
                completionHandler:nil];
        });
    }
    if (getenv("CODEG_QUOTA_TEST_DEBUG")) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(4.5 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            NSString *probe =
                @"(function(){try{var p=document.getElementById('opencode-quota-popup');"
                 "return 'display='+(p?p.style.display:'null')+' len='+(p?p.innerHTML.length:0)"
                 "+' top='+(p?p.style.top:'')+' left='+(p?p.style.left:'');}catch(e){return 'ERR '+e.message;}})()";
            [self.webView evaluateJavaScript:probe
                           completionHandler:^(id result, NSError *err) {
                NSLog(@"[debug] popup probe: %@ (err=%@)", result, err.localizedDescription);
            }];
            [self.webView evaluateJavaScript:
                @"(function(){try{return 'provTab='+localStorage.getItem('opencode-quota-provider');}catch(e){return 'lsERR';}})()"
                           completionHandler:^(id result, NSError *err) {
                NSLog(@"[debug] %@", result);
            }];
        });
    }

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        WKSnapshotConfiguration *sc = [[WKSnapshotConfiguration alloc] init];
        [self.webView takeSnapshotWithConfiguration:sc
                                  completionHandler:^(NSImage *img, NSError *err) {
            if (img) {
                NSBitmapImageRep *rep = [NSBitmapImageRep imageRepWithData:[img TIFFRepresentation]];
                NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
                [png writeToFile:@"/tmp/codeg-quota-test.png" atomically:YES];
                NSLog(@"[test-host] snapshot written to /tmp/codeg-quota-test.png");
            } else {
                NSLog(@"[test-host] snapshot failed: %@", err);
            }
            [NSApp terminate:nil];
        }];
    });
}
@end

int main(void) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        AppDelegate *delegate = [[AppDelegate alloc] init];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
