#pragma once
#include_next <windows.h>
/* libstdc++ 16 pulls windows.h into nearly every TU via <thread>; undo the
   winapi macros that collide with KiCad/wx method names.  Code that needs
   the real functions uses the explicit W/A names. */
#ifdef __cplusplus
#undef GetClassInfo
#undef GetClassName
#undef LoadLibrary
#undef LoadIcon
#undef LoadBitmap
#undef LoadMenu
#undef DrawText
#undef FindWindow
#undef GetCharWidth
#undef StartDoc
#undef GetObject
#undef GetFirstChild
#undef GetNextSibling
#undef GetPrevSibling
#undef GetWindowStyle
#undef IsMaximized
#undef IsMinimized
#undef CreateDialog
#undef CreateFont
#undef CreateEvent
#undef GetMessage
#undef SendMessage
#undef PostMessage
#undef GetUserName
#undef GetComputerName
#undef GetTempPath
#undef GetTempFileName
#undef CopyFile
#undef MoveFile
#undef DeleteFile
#undef CreateDirectory
#undef RemoveDirectory
#undef SetCurrentDirectory
#undef GetCurrentDirectory
#undef GetEnvironmentVariable
#undef SetEnvironmentVariable
#undef GetCurrentTime
#undef PlaySound
#endif
