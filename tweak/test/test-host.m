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
