//
//  WidgetBridgePlugin.m
//  App
//
//  Capacitor plugin registration shim for WidgetBridgePlugin.swift.
//  CAP_PLUGIN is an ObjC macro that emits a +load class method to
//  register the plugin with Capacitor's bridge at app launch. The
//  Swift CAPBridgedPlugin protocol provides the metadata; this file
//  is what actually causes the plugin to be discovered.
//

#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(WidgetBridgePlugin, "WidgetBridge",
    CAP_PLUGIN_METHOD(setToken, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getToken, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(clearToken, CAPPluginReturnPromise);
)
