/*
* This program source code file is part of KiCad, a free EDA CAD application.
*
* Copyright (C) 2020 Mark Roszko <mark.roszko@gmail.com>
* Copyright The KiCad Developers, see AUTHORS.txt for contributors.
*
* This program is free software: you can redistribute it and/or modify it
* under the terms of the GNU General Public License as published by the
* Free Software Foundation, either version 3 of the License, or (at your
* option) any later version.
*
* This program is distributed in the hope that it will be useful, but
* WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
* General Public License for more details.
*
* You should have received a copy of the GNU General Public License
* along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

#include <kiplatform/app.h>

#include <wx/string.h>
#include <wx/sysopt.h>

#import <Cocoa/Cocoa.h>
#include <objc/runtime.h>

#include <cstdio>


static std::function<void( const wxString& )> s_urlSchemeHandler;


// The kAEGetURL handler method body (an IMP installed on a runtime-built class).
static void handleGetURLEvent( id aSelf, SEL aCmd, NSAppleEventDescriptor* aEvent,
                               NSAppleEventDescriptor* aReply )
{
    (void) aSelf;
    (void) aCmd;
    (void) aReply;

    NSString* url = [[aEvent paramDescriptorForKeyword:keyDirectObject] stringValue];

    if( url && s_urlSchemeHandler )
        s_urlSchemeHandler( wxString::FromUTF8( [url UTF8String] ) );
}


bool KIPLATFORM::APP::Init()
{
    // KiCad relies on showing the file type selector in a few places; force it to be shown
    wxSystemOptions::SetOption( wxS( "osx.openfiledialog.always-show-types" ), 1 );
    return true;
}


void KIPLATFORM::APP::EnableDarkMode( bool aForce )
{
}


bool KIPLATFORM::APP::AttachConsole( bool aTryAlloc )
{
    // Not implemented on this platform
    return true;
}


bool KIPLATFORM::APP::IsOperatingSystemUnsupported()
{
    // Not implemented on this platform
    return false;
}


bool KIPLATFORM::APP::RegisterApplicationRestart( const wxString& aCommandLine )
{
    // Not implemented on this platform
    return true;
}


bool KIPLATFORM::APP::UnregisterApplicationRestart()
{
    // Not implemented on this platform
    return true;
}


bool KIPLATFORM::APP::SupportsShutdownBlockReason()
{
    return false;
}


void KIPLATFORM::APP::RemoveShutdownBlockReason( wxWindow* aWindow )
{
}


void KIPLATFORM::APP::SetShutdownBlockReason( wxWindow* aWindow, const wxString& aReason )
{
}


void KIPLATFORM::APP::ForceTimerMessagesToBeCreatedIfNecessary()
{
}


void KIPLATFORM::APP::AddDynamicLibrarySearchPath( const wxString& aPath )
{
}


void KIPLATFORM::APP::RegisterURLSchemeHandler(
        std::function<void( const wxString& aUrl )> aHandler )
{
    static id handler = nil;

    s_urlSchemeHandler = std::move( aHandler );

    if( !handler )
    {
        // The handler class is built at runtime under an image-unique name:
        // kiplatform is linked into several images (the app, kicommon, the
        // kifaces), and a compiled-in Objective-C class would be registered by
        // each of them, leaving the runtime to keep one arbitrarily — with the
        // static above belonging to a different image than the method.
        char name[64];
        snprintf( name, sizeof( name ), "KICAD_URL_SCHEME_HANDLER_%p",
                  (void*) &handleGetURLEvent );

        Class cls = objc_allocateClassPair( [NSObject class], name, 0 );
        class_addMethod( cls, @selector( handleGetURLEvent:withReplyEvent: ),
                         (IMP) handleGetURLEvent, "v@:@@" );
        objc_registerClassPair( cls );

        handler = [[cls alloc] init];
    }

    [[NSAppleEventManager sharedAppleEventManager]
            setEventHandler:handler
                andSelector:@selector( handleGetURLEvent:withReplyEvent: )
              forEventClass:kInternetEventClass
                 andEventID:kAEGetURL];
}
