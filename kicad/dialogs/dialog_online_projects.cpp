/*
 * This program source code file is part of KiCad, a free EDA CAD application.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
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

#include "dialog_online_projects.h"
#include "dialog_share_project.h"

#include <algorithm>
#include <iterator>
#include <optional>
#include <string>

#include <collab/collab_project.h>
#include <collab/collab_rest.h>
#include <collab/collab_session.h>
#include <kicad_manager_frame.h>
#include <paths.h>
#include <project.h>

#include <wx/app.h>
#include <wx/button.h>
#include <wx/clipbrd.h>
#include <wx/dataobj.h>
#include <wx/dataview.h>
#include <wx/dir.h>
#include <wx/dirdlg.h>
#include <wx/ffile.h>
#include <wx/filename.h>
#include <wx/menu.h>
#include <wx/msgdlg.h>
#include <wx/sizer.h>
#include <wx/srchctrl.h>
#include <wx/stattext.h>
#include <wx/textctrl.h>
#include <wx/choicdlg.h>
#include <wx/textdlg.h>
#include <wx/utils.h>


/// Popup menu commands: for a project row, and for the "New Online Project" button.
enum ONLINE_PROJECT_MENU_ID
{
    ID_ONLINE_OPEN = wxID_HIGHEST + 1,
    ID_ONLINE_OPEN_IN_FOLDER,
    ID_ONLINE_OPEN_IN_BROWSER,
    ID_ONLINE_SHARE,
    ID_ONLINE_COPY_WEB_LINK,
    ID_ONLINE_TOGGLE_STAR,
    ID_ONLINE_DETAILS,
    ID_ONLINE_RENAME,
    ID_ONLINE_TOGGLE_PUBLIC,
    ID_ONLINE_MAKE_COPY,
    ID_ONLINE_DELETE_OR_LEAVE,
    ID_ONLINE_RESTORE,
    ID_ONLINE_NEW_PUBLISH,
    ID_ONLINE_NEW_BLANK,
    ID_ONLINE_NEW_FOLDER
};


/// The columns of the project list, which are also the columns of its model.
enum ONLINE_PROJECT_COLUMN
{
    COL_STAR = 0,
    COL_NAME,
    COL_OWNER,
    COL_ROLE,
    COL_VISIBILITY,
    COL_LOCAL_COPY,
    COL_DOCUMENTS,
    COL_EDITED,
    COL_DESCRIPTION
};


/// How many "<name> (N)" siblings to try before giving up on a free folder name.
static constexpr int MAX_SIBLING_COPIES = 500;

/// What the server accepts for a project's name (characters) and description (bytes).
static constexpr int    MAX_PROJECT_NAME_CHARS = 120;
static constexpr size_t MAX_PROJECT_DESCRIPTION_BYTES = 2000;

/// The sort order the list was left in.  Kept in a small file beside the other user
/// settings, so it is still there the next time KiCad starts.
static int  s_sortColumn = wxNOT_FOUND;
static bool s_sortAscending = true;
static bool s_sortLoaded = false;


static wxString sortOrderFile()
{
    return wxFileName( PATHS::GetUserSettingsPath(), wxS( "collab_online_projects.json" ) )
            .GetFullPath();
}


static void loadSortOrder()
{
    if( s_sortLoaded )
        return;

    s_sortLoaded = true;

    wxString path = sortOrderFile();

    if( !wxFileName::FileExists( path ) )
        return;

    wxFFile  file( path, wxS( "rb" ) );
    wxString text;

    if( !file.IsOpened() || !file.ReadAll( &text, wxConvUTF8 ) )
        return;

    try
    {
        nlohmann::json saved = nlohmann::json::parse( text.ToStdString( wxConvUTF8 ) );

        if( saved.is_object() )
        {
            s_sortColumn = saved.value( "sortColumn", (int) wxNOT_FOUND );
            s_sortAscending = saved.value( "sortAscending", true );
        }
    }
    catch( ... )
    {
        // A damaged file only loses the preference.
        s_sortColumn = wxNOT_FOUND;
        s_sortAscending = true;
    }
}


static void saveSortOrder()
{
    nlohmann::json saved = { { "sortColumn", s_sortColumn }, { "sortAscending", s_sortAscending } };

    wxFFile file( sortOrderFile(), wxS( "wb" ) );

    if( file.IsOpened() )
        file.Write( wxString::FromUTF8( saved.dump( 2 ) ), wxConvUTF8 );
}


/// The mark in the star column.
static wxString starMark()
{
    return wxString::FromUTF8( "\xE2\x98\x85" );
}


/// "2026-08-28T17:03:12.345+00:00" -> "2026-08-28 17:03" (good enough for a list).
static wxString prettyTimestamp( const wxString& aRfc3339 )
{
    wxString ts = aRfc3339;

    if( ts.length() >= 16 )
    {
        ts = ts.Left( 16 );
        ts.Replace( wxS( "T" ), wxS( " " ) );
    }

    return ts;
}


/// True for the device names Windows reserves in every folder, with or without an
/// extension: "NUL", "com1", "Aux.txt".
static bool isReservedDeviceName( const wxString& aName )
{
    static const wxChar* const reserved[] = { wxS( "CON" ), wxS( "PRN" ), wxS( "AUX" ),
                                              wxS( "NUL" ) };

    wxString stem = aName.BeforeFirst( '.' ).Upper();

    stem.Trim( true );

    for( const wxChar* name : reserved )
    {
        if( stem == name )
            return true;
    }

    // COM1...COM9 and LPT1...LPT9.
    return stem.length() == 4
           && ( stem.StartsWith( wxS( "COM" ) ) || stem.StartsWith( wxS( "LPT" ) ) )
           && stem[3] >= '1' && stem[3] <= '9';
}


/**
 * A project name that is safe as the name of one directory: no separators or other
 * characters a file system refuses, nothing that means "this folder" or "the folder
 * above" ("." and ".."), no leading or trailing dots and spaces (Windows drops them, and
 * a leading dot hides the folder elsewhere) and no reserved device name.  The name comes
 * from whoever named the online project, so it is not to be trusted.
 */
static wxString sanitizeDirName( const wxString& aName )
{
    wxString out;

    for( wxUniChar c : aName )
    {
        if( c < 0x20 || c == 0x7F || wxString( wxS( "/\\:*?\"<>|" ) ).Contains( c ) )
            out += '_';
        else
            out += c;
    }

    while( !out.IsEmpty() && ( out.Last() == '.' || out.Last() == ' ' ) )
        out.RemoveLast();

    while( !out.IsEmpty() && ( out[0] == '.' || out[0] == ' ' ) )
        out.Remove( 0, 1 );

    if( out.IsEmpty() )
        return wxS( "untitled" );

    if( isReservedDeviceName( out ) )
        out.Prepend( wxS( "_" ) );

    return out;
}


/// True when aDir is a directory directly inside aParentDir once both paths are made
/// absolute and their "." and ".." are resolved: the last line of defence against a
/// folder name that would climb out of, or stay in, the folder it was meant to go into.
static bool isDirectChildDir( const wxString& aParentDir, const wxString& aDir )
{
    wxFileName parent = wxFileName::DirName( aParentDir );
    wxFileName child = wxFileName::DirName( aDir );

    if( !parent.Normalize( wxPATH_NORM_DOTS | wxPATH_NORM_ABSOLUTE )
        || !child.Normalize( wxPATH_NORM_DOTS | wxPATH_NORM_ABSOLUTE ) )
    {
        return false;
    }

    if( child.GetDirCount() != parent.GetDirCount() + 1 )
        return false;

    wxString name = child.GetDirs().Last();

    if( name.IsEmpty() || name == wxS( "." ) || name == wxS( ".." ) )
        return false;

    child.RemoveLastDir();

    return child.SameAs( parent );
}


/// A string member of a JSON object, or empty when it is missing, null or not a string.
static wxString jsonStr( const nlohmann::json& aObject, const char* aKey )
{
    if( !aObject.is_object() )
        return wxEmptyString;

    auto it = aObject.find( aKey );

    if( it == aObject.end() || !it->is_string() )
        return wxEmptyString;

    return wxString::FromUTF8( it->get<std::string>() );
}


/// An integer member of a JSON object, or aDefault.
static long long jsonInt( const nlohmann::json& aObject, const char* aKey, long long aDefault )
{
    if( !aObject.is_object() )
        return aDefault;

    auto it = aObject.find( aKey );

    if( it == aObject.end() || !it->is_number_integer() )
        return aDefault;

    return it->get<long long>();
}


/// A boolean member of a JSON object, or false.
static bool jsonBool( const nlohmann::json& aObject, const char* aKey )
{
    if( !aObject.is_object() )
        return false;

    auto it = aObject.find( aKey );

    return it != aObject.end() && it->is_boolean() && it->get<bool>();
}


/// The .kicad_pro in aDir that is linked to the online project aProjectId, or empty.
static wxString linkedProFile( const wxString& aDir, const wxString& aProjectId )
{
    if( !wxFileName::DirExists( aDir ) )
        return wxEmptyString;

    // The archive may keep its .kicad_pro in a subfolder, and the link sits beside it.
    wxArrayString proFiles;
    wxDir::GetAllFiles( aDir, &proFiles, wxS( "*.kicad_pro" ), wxDIR_FILES | wxDIR_DIRS );

    for( const wxString& proFile : proFiles )
    {
        wxFileName pro( proFile );
        wxString   linkedServer;

        if( COLLAB_PROJECT::ReadLocalLink( pro.GetPath(), pro.GetName(), linkedServer )
            == aProjectId )
        {
            return proFile;
        }
    }

    return wxEmptyString;
}


/// True for an existing directory with nothing in it.
static bool dirIsEmpty( const wxString& aDir )
{
    wxDir dir( aDir );

    return dir.IsOpened() && !dir.HasFiles() && !dir.HasSubDirs();
}


/// True when aDir holds a download of aProjectId that came without any .kicad_pro: such a
/// copy is linked under the name the download was given rather than beside a project file.
static bool dirIsProLessCopy( const wxString& aDir, const wxString& aDirName,
                              const wxString& aProjectId )
{
    wxString linkedServer;

    return wxFileName::DirExists( aDir )
           && COLLAB_PROJECT::ReadLocalLink( aDir, aDirName, linkedServer ) == aProjectId;
}


/**
 * Where under aParentDir a local copy of aProjectId can live: <aDirName>, or the first
 * "<aDirName> (N)" sibling, that does not exist yet, is empty, or already is a copy of this
 * very project (then aExistingPro receives its .kicad_pro, or stays empty for an earlier
 * download that had no .kicad_pro in it).  A folder holding anything else is never returned,
 * so nothing unrelated gets downloaded over, and neither is anything that is not a folder
 * directly inside aParentDir.  Empty if no name is free.
 */
static wxString pickTargetDir( const wxString& aParentDir, const wxString& aDirName,
                               const wxString& aProjectId, wxString& aExistingPro )
{
    aExistingPro.clear();

    for( int n = 1; n <= MAX_SIBLING_COPIES; n++ )
    {
        wxFileName candidate( aParentDir, wxEmptyString );

        if( n == 1 )
            candidate.AppendDir( aDirName );
        else
            candidate.AppendDir( wxString::Format( wxS( "%s (%d)" ), aDirName, n ) );

        wxString path = candidate.GetPath();

        // Whatever aDirName is, the copy goes one level below aParentDir or nowhere.
        if( !isDirectChildDir( aParentDir, path ) )
            return wxEmptyString;

        // A plain file of that name is in the way just like an unrelated folder.
        if( wxFileName::FileExists( path ) )
            continue;

        if( !wxFileName::DirExists( path ) )
            return path;

        aExistingPro = linkedProFile( path, aProjectId );

        if( !aExistingPro.IsEmpty() || dirIsEmpty( path )
            || dirIsProLessCopy( path, aDirName, aProjectId ) )
        {
            return path;
        }
    }

    return wxEmptyString;
}


static bool copyToClipboard( const wxString& aText )
{
    if( !wxTheClipboard->Open() )
        return false;

    wxTheClipboard->SetData( new wxTextDataObject( aText ) );
    wxTheClipboard->Close();

    return true;
}


/// The address of a project in the web app.
static wxString projectWebUrl( const wxString& aProjectId )
{
    return COLLAB_SESSION::ServerUrl() + wxS( "/p/" ) + aProjectId + wxS( "/edit" );
}


/**
 * The model behind the project list.  It sorts by what a column means rather than by the
 * text in it (Last Edited by the timestamp, not by its shortened label) and keeps starred
 * projects on top whatever the order, as the web app does.
 */
class ONLINE_PROJECT_STORE : public wxDataViewListStore
{
public:
    /// What one row sorts by.
    struct SORT_KEY
    {
        bool     starred = false;
        bool     localCopy = false;
        wxString name;
        wxString owner;
        wxString edited;   ///< RFC 3339, all in UTC: sorts as text
    };

    /// The keys of the rows about to be appended, by row.  Call with the list empty.
    void SetSortKeys( std::vector<SORT_KEY> aKeys ) { m_keys = std::move( aKeys ); }

    int Compare( const wxDataViewItem& aItem1, const wxDataViewItem& aItem2,
                 unsigned int aColumn, bool aAscending ) const override
    {
        unsigned row1 = GetRow( aItem1 );
        unsigned row2 = GetRow( aItem2 );
        int      byRow = row1 < row2 ? -1 : ( row1 > row2 ? 1 : 0 );

        if( row1 >= m_keys.size() || row2 >= m_keys.size() )
            return byRow;

        const SORT_KEY& a = m_keys[ row1 ];
        const SORT_KEY& b = m_keys[ row2 ];

        if( a.starred != b.starred )
            return a.starred ? -1 : 1;

        int order = 0;

        switch( aColumn )
        {
        case COL_NAME:       order = a.name.CmpNoCase( b.name );               break;
        case COL_OWNER:      order = a.owner.CmpNoCase( b.owner );             break;
        case COL_LOCAL_COPY: order = (int) b.localCopy - (int) a.localCopy;    break;
        case COL_EDITED:     order = a.edited.Cmp( b.edited );                 break;
        default:                                                               break;
        }

        // Rows were appended in the server's order; ties keep it.
        if( order == 0 )
            return byRow;

        return aAscending ? order : -order;
    }

private:
    std::vector<SORT_KEY> m_keys;
};


/**
 * Name and description of an online project.
 */
class DIALOG_ONLINE_PROJECT_DETAILS : public DIALOG_SHIM
{
public:
    DIALOG_ONLINE_PROJECT_DETAILS( wxWindow* aParent, const wxString& aName,
                                   const wxString& aDescription ) :
            DIALOG_SHIM( aParent, wxID_ANY, _( "Online Project Details" ), wxDefaultPosition,
                         wxSize( 480, 320 ), wxDEFAULT_DIALOG_STYLE | wxRESIZE_BORDER )
    {
        wxBoxSizer* mainSizer = new wxBoxSizer( wxVERTICAL );

        m_name = new wxTextCtrl( this, wxID_ANY, aName );
        m_name->SetMaxLength( MAX_PROJECT_NAME_CHARS );

        m_description = new wxTextCtrl( this, wxID_ANY, aDescription, wxDefaultPosition,
                                        wxSize( -1, 120 ), wxTE_MULTILINE );
        m_description->SetToolTip( _( "Shown in the project list and, for a public project, "
                                      "in the server's gallery" ) );

        mainSizer->Add( new wxStaticText( this, wxID_ANY, _( "Name:" ) ), 0,
                        wxLEFT | wxRIGHT | wxTOP, 10 );
        mainSizer->Add( m_name, 0, wxEXPAND | wxLEFT | wxRIGHT | wxTOP, 10 );
        mainSizer->Add( new wxStaticText( this, wxID_ANY, _( "Description:" ) ), 0,
                        wxLEFT | wxRIGHT | wxTOP, 10 );
        mainSizer->Add( m_description, 1, wxEXPAND | wxALL, 10 );
        mainSizer->Add( CreateStdDialogButtonSizer( wxOK | wxCANCEL ), 0, wxEXPAND | wxALL, 5 );

        SetSizer( mainSizer );
        SetInitialFocus( m_name );

        finishDialogSettings();
    }

    wxString GetProjectName() const { return m_name->GetValue().Strip( wxString::both ); }

    wxString GetProjectDescription() const
    {
        return m_description->GetValue().Strip( wxString::both );
    }

    bool TransferDataFromWindow() override
    {
        wxString name = GetProjectName();
        wxString problem;

        // What the server would refuse, said before the round trip.
        if( name.IsEmpty() )
        {
            problem = _( "The project needs a name." );
        }
        else if( name.find_first_not_of( wxS( ". " ) ) == wxString::npos )
        {
            problem = _( "The name must contain a letter or a digit." );
        }
        else if( GetProjectDescription().utf8_str().length() > MAX_PROJECT_DESCRIPTION_BYTES )
        {
            // The server counts UTF-8 bytes, which is what a non-Latin text runs out of
            // long before it is 2000 characters long.
            problem = wxString::Format( _( "The description is too long: it takes %d bytes "
                                           "and the server accepts %d at most.  Shorten "
                                           "it." ),
                                        (int) GetProjectDescription().utf8_str().length(),
                                        (int) MAX_PROJECT_DESCRIPTION_BYTES );
        }

        if( problem.IsEmpty() )
            return true;

        wxMessageBox( problem, GetTitle(), wxOK | wxICON_ERROR, this );
        return false;
    }

private:
    wxTextCtrl* m_name;
    wxTextCtrl* m_description;
};


DIALOG_ONLINE_PROJECTS::DIALOG_ONLINE_PROJECTS( KICAD_MANAGER_FRAME* aParent ) :
        DIALOG_SHIM( aParent, wxID_ANY, _( "Online Projects" ), wxDefaultPosition,
                     wxSize( 940, 520 ), wxDEFAULT_DIALOG_STYLE | wxRESIZE_BORDER ),
        m_frame( aParent ),
        m_alive( std::make_shared<bool>( true ) ),
        m_auth( std::make_unique<COLLAB_AUTH>() ),
        m_store( nullptr ),
        m_myUserId( -1 ),
        m_signedIn( false ),
        m_loaded( false ),
        m_loadFailed( false ),
        m_showTrash( false ),
        m_populating( false ),
        m_busy( 0 ),
        m_signingIn( false ),
        m_downloading( false ),
        m_publishing( false ),
        m_refreshGeneration( 0 )
{
    wxBoxSizer* mainSizer = new wxBoxSizer( wxVERTICAL );

    // -- Sign-in row --------------------------------------------------------
    wxBoxSizer* authSizer = new wxBoxSizer( wxHORIZONTAL );

    m_signedInLabel = new wxStaticText( this, wxID_ANY, _( "Not signed in" ) );
    m_joinButton = new wxButton( this, wxID_ANY, _( "Join from Link..." ) );
    m_newButton = new wxButton( this, wxID_ANY, _( "New Online Project" ) );
    m_trashButton = new wxButton( this, wxID_ANY, _( "Show Trash" ) );
    m_refreshButton = new wxButton( this, wxID_ANY, _( "Refresh" ) );
    m_signInButton = new wxButton( this, wxID_ANY, _( "Sign In..." ) );

    m_refreshButton->SetToolTip( _( "Reload the list from the server (F5)" ) );

    authSizer->Add( m_signedInLabel, 1, wxALIGN_CENTER_VERTICAL | wxLEFT, 5 );
    authSizer->Add( m_joinButton, 0, wxRIGHT, 5 );
    authSizer->Add( m_newButton, 0, wxRIGHT, 15 );
    authSizer->Add( m_trashButton, 0, wxRIGHT, 5 );
    authSizer->Add( m_refreshButton, 0, wxRIGHT, 5 );
    authSizer->Add( m_signInButton, 0, wxRIGHT, 5 );

    mainSizer->Add( authSizer, 0, wxEXPAND | wxALL, 5 );

    // -- Filter -------------------------------------------------------------
    m_search = new wxSearchCtrl( this, wxID_ANY, wxEmptyString, wxDefaultPosition,
                                 wxDefaultSize );
    m_search->ShowCancelButton( true );

    mainSizer->Add( m_search, 0, wxEXPAND | wxLEFT | wxRIGHT | wxBOTTOM, 10 );

    // -- Project list -------------------------------------------------------
    m_list = new wxDataViewListCtrl( this, wxID_ANY, wxDefaultPosition, wxDefaultSize,
                                     wxDV_ROW_LINES | wxDV_SINGLE );

    // Our own model, for its sort order; in place before any column is added to it.
    m_store = new ONLINE_PROJECT_STORE();
    m_list->AssociateModel( m_store );
    m_store->DecRef();

    const int sortable = wxDATAVIEW_COL_RESIZABLE | wxDATAVIEW_COL_SORTABLE;

    // In the order of ONLINE_PROJECT_COLUMN.
    m_list->AppendTextColumn( starMark(), wxDATAVIEW_CELL_INERT, 30, wxALIGN_CENTER, 0 );
    m_list->AppendTextColumn( _( "Name" ), wxDATAVIEW_CELL_INERT, 220, wxALIGN_NOT, sortable );
    m_list->AppendTextColumn( _( "Owner" ), wxDATAVIEW_CELL_INERT, 110, wxALIGN_NOT, sortable );
    m_list->AppendTextColumn( _( "Your Role" ), wxDATAVIEW_CELL_INERT, 80 );
    m_list->AppendTextColumn( _( "Visibility" ), wxDATAVIEW_CELL_INERT, 80 );
    m_list->AppendTextColumn( _( "Local Copy" ), wxDATAVIEW_CELL_INERT, 130, wxALIGN_NOT,
                              sortable );
    m_list->AppendTextColumn( _( "Documents" ), wxDATAVIEW_CELL_INERT, 80 );
    m_list->AppendTextColumn( _( "Last Edited" ), wxDATAVIEW_CELL_INERT, 130, wxALIGN_NOT,
                              sortable );
    m_list->AppendTextColumn( _( "Description" ), wxDATAVIEW_CELL_INERT, 240 );

    loadSortOrder();

    if( s_sortColumn >= 0 && s_sortColumn < (int) m_list->GetColumnCount() )
        m_list->GetColumn( s_sortColumn )->SetSortOrder( s_sortAscending );

    mainSizer->Add( m_list, 1, wxEXPAND | wxLEFT | wxRIGHT, 10 );

    // -- Action buttons -----------------------------------------------------
    wxBoxSizer* buttonSizer = new wxBoxSizer( wxHORIZONTAL );

    m_openButton = new wxButton( this, wxID_ANY, _( "Open" ) );
    m_openInButton = new wxButton( this, wxID_ANY, _( "Open in Folder..." ) );
    m_shareButton = new wxButton( this, wxID_ANY, _( "Share..." ) );
    m_detailsButton = new wxButton( this, wxID_ANY, _( "Project Details..." ) );
    m_publicButton = new wxButton( this, wxID_ANY, _( "Make Public" ) );
    m_deleteButton = new wxButton( this, wxID_ANY, _( "Move to Trash..." ) );

    m_openInButton->SetToolTip( _( "Choose where the local working copy is stored, then "
                                   "open the project" ) );
    m_detailsButton->SetToolTip( _( "Change the name and the description of the project "
                                    "(F2 renames it)" ) );

    buttonSizer->Add( m_openButton, 0, wxRIGHT, 5 );
    buttonSizer->Add( m_openInButton, 0, wxRIGHT, 15 );
    buttonSizer->Add( m_shareButton, 0, wxRIGHT, 5 );
    buttonSizer->Add( m_detailsButton, 0, wxRIGHT, 5 );
    buttonSizer->Add( m_publicButton, 0, wxRIGHT, 5 );
    buttonSizer->AddStretchSpacer();
    buttonSizer->Add( m_deleteButton, 0, wxRIGHT, 5 );

    mainSizer->Add( buttonSizer, 0, wxEXPAND | wxALL, 10 );

    // -- Status line --------------------------------------------------------
    wxBoxSizer* statusSizer = new wxBoxSizer( wxHORIZONTAL );

    m_statusLabel = new wxStaticText( this, wxID_ANY, wxEmptyString, wxDefaultPosition,
                                      wxDefaultSize, wxST_NO_AUTORESIZE | wxST_ELLIPSIZE_END );

    // Only there while the notice on show is about something that can be undone.
    m_undoButton = new wxButton( this, wxID_ANY, _( "Undo" ), wxDefaultPosition, wxDefaultSize,
                                 wxBU_EXACTFIT );
    m_undoButton->Hide();

    statusSizer->Add( m_statusLabel, 1, wxALIGN_CENTER_VERTICAL );
    statusSizer->Add( m_undoButton, 0, wxALIGN_CENTER_VERTICAL | wxLEFT, 10 );

    mainSizer->Add( statusSizer, 0, wxEXPAND | wxLEFT | wxRIGHT, 10 );

    mainSizer->Add( CreateStdDialogButtonSizer( wxCLOSE ), 0, wxEXPAND | wxALL, 5 );

    SetSizer( mainSizer );

    m_signInButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onSignInOut, this );
    m_refreshButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onRefresh, this );
    m_trashButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onToggleTrash, this );
    m_openButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onOpen, this );
    m_openInButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onOpenInFolder, this );
    m_shareButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onShare, this );
    m_detailsButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onDetails, this );
    m_publicButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onTogglePublic, this );
    m_deleteButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onDelete, this );
    m_newButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onNewProject, this );
    m_joinButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onJoinLink, this );
    m_undoButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onUndo, this );
    m_search->Bind( wxEVT_TEXT, &DIALOG_ONLINE_PROJECTS::onSearchText, this );
    m_search->Bind( wxEVT_SEARCHCTRL_CANCEL_BTN,
                    [this]( wxCommandEvent& )
                    {
                        clearFilter();
                    } );
    m_list->Bind( wxEVT_DATAVIEW_ITEM_ACTIVATED, &DIALOG_ONLINE_PROJECTS::onItemActivated, this );
    m_list->Bind( wxEVT_DATAVIEW_SELECTION_CHANGED, &DIALOG_ONLINE_PROJECTS::onSelectionChanged,
                  this );
    m_list->Bind( wxEVT_DATAVIEW_ITEM_CONTEXT_MENU, &DIALOG_ONLINE_PROJECTS::onContextMenu,
                  this );

    // Bound after DIALOG_SHIM's own handler, so this one is asked first.
    Bind( wxEVT_CLOSE_WINDOW, &DIALOG_ONLINE_PROJECTS::onClose, this );

    // A deep link / menu can pre-load a share link to join as soon as we show.
    Bind( wxEVT_SHOW,
          [this]( wxShowEvent& aEvt )
          {
              aEvt.Skip();

              if( aEvt.IsShown() && !m_pendingJoinLink.IsEmpty() )
              {
                  wxString link = m_pendingJoinLink;
                  m_pendingJoinLink.Clear();
                  CallAfter( [this, link]() { JoinWithLink( link, /* aOpenWithoutAsking */ true ); } );
              }
          } );

    SetInitialFocus( m_list );

    updatePublishable();
    applyViewMode();

    finishDialogSettings();

    refresh();
}


DIALOG_ONLINE_PROJECTS::~DIALOG_ONLINE_PROJECTS()
{
    if( m_alive )
        *m_alive = false;

    wxDataViewColumn* sorting = m_list->GetSortingColumn();

    int  column = sorting ? (int) sorting->GetModelColumn() : wxNOT_FOUND;
    bool ascending = !sorting || sorting->IsSortOrderAscending();

    if( column != s_sortColumn || ascending != s_sortAscending )
    {
        s_sortColumn = column;
        s_sortAscending = ascending;
        saveSortOrder();
    }
}


void DIALOG_ONLINE_PROJECTS::updateSignInState()
{
    wxString label;
    wxString button = _( "Sign Out" );

    if( m_signingIn )
    {
        label = _( "Signing in..." );
        button = _( "Cancel Sign-In" );
    }
    else if( !m_signedIn )
    {
        label = _( "Not signed in" );
        button = _( "Sign In..." );
    }
    else if( m_myLogin.IsEmpty() )
    {
        label = wxString::Format( _( "Signed in  —  %s" ), COLLAB_SESSION::ServerUrl() );
    }
    else
    {
        label = wxString::Format( _( "Signed in as %s  —  %s" ), m_myLogin,
                                  COLLAB_SESSION::ServerUrl() );
    }

    m_signedInLabel->SetLabel( label );

    if( m_signInButton->GetLabel() != button )
    {
        m_signInButton->SetLabel( button );
        Layout();
    }
}


void DIALOG_ONLINE_PROJECTS::applyViewMode()
{
    // The Trash only ever holds the user's own projects, and nothing in it has a role,
    // a star or an audience.
    for( int column : { COL_STAR, COL_OWNER, COL_ROLE, COL_VISIBILITY } )
        m_list->GetColumn( column )->SetHidden( m_showTrash );

    m_list->GetColumn( COL_EDITED )->SetTitle( m_showTrash ? _( "Deleted" )
                                                           : _( "Last Edited" ) );
    m_list->GetColumn( COL_DESCRIPTION )->SetTitle( m_showTrash ? _( "Deleted Permanently On" )
                                                                : _( "Description" ) );

    m_search->SetDescriptiveText( m_showTrash ? _( "Filter by name" )
                                              : _( "Filter by name, owner or description" ) );

    m_trashButton->SetLabel( m_showTrash ? _( "Show Projects" ) : _( "Show Trash" ) );
    m_trashButton->SetToolTip( m_showTrash ? _( "Go back to your online projects" )
                                           : _( "Show the projects you deleted in the last 30 "
                                                "days, to restore them or delete them for "
                                                "good" ) );

    m_openButton->SetLabel( m_showTrash ? _( "Restore" ) : _( "Open" ) );
    m_openButton->SetToolTip( m_showTrash ? _( "Take the project back out of the Trash, with "
                                               "everyone's access as it was" )
                                          : _( "Open the project, downloading a local working "
                                               "copy the first time" ) );

    for( wxButton* button : { m_openInButton, m_shareButton, m_detailsButton, m_publicButton } )
        button->Show( !m_showTrash );

    updateControls();
    Layout();
}


void DIALOG_ONLINE_PROJECTS::showTrash( bool aShowTrash )
{
    if( m_showTrash == aShowTrash )
        return;

    m_showTrash = aShowTrash;

    // The rows of the other list mean nothing here.
    m_allProjects.clear();
    m_selectAfterRefresh.clear();
    m_loaded = false;
    m_loadFailed = false;

    applyViewMode();
    applyFilter();
    refresh();
}


void DIALOG_ONLINE_PROJECTS::updatePublishable()
{
    PROJECT& project = m_frame->Prj();
    wxString linkedServer;

    m_publishBlocked.clear();

    if( project.IsNullProject() )
    {
        m_publishBlocked = _( "No project is open in the project manager." );
    }
    else if( !COLLAB_PROJECT::ReadLocalLink( project.GetProjectPath(), project.GetProjectName(),
                                             linkedServer )
                      .IsEmpty() )
    {
        // One online project per local folder.
        m_publishBlocked = _( "The project open in the project manager is an online project "
                              "already." );
    }

    // A disabled menu item cannot say why it is disabled; the button that opens the
    // menu can.
    if( m_publishBlocked.IsEmpty() )
    {
        m_newButton->SetToolTip( _( "Publish the project open in the project manager or "
                                    "one from a folder, or start a blank online project" ) );
    }
    else
    {
        m_newButton->SetToolTip( wxString::Format( _( "Publish a project from a folder or "
                                                      "start a blank online project.  "
                                                      "Publish Current Project is not "
                                                      "available: %s" ),
                                                   m_publishBlocked ) );
    }
}


void DIALOG_ONLINE_PROJECTS::updateControls()
{
    const nlohmann::json* project = selectedProject();
    bool                  idle = m_busy == 0;
    bool                  owner = ownsSelected();

    // Without /api/me there is no telling owner from member, so neither Delete
    // nor Leave can be offered honestly.
    bool                  knowMe = m_myUserId >= 0;

    m_openButton->Enable( idle && project );
    m_openInButton->Enable( idle && project );
    m_shareButton->Enable( idle && project );
    m_detailsButton->Enable( idle && owner );
    m_publicButton->Enable( idle && owner );
    m_deleteButton->Enable( idle && project && ( knowMe || m_showTrash ) );

    // Nothing that prompts may be started during a browser sign-in: its completion
    // (and what was waiting for it) would then run underneath that prompt.  The sign-in
    // button itself is how a stuck one is abandoned.
    m_joinButton->Enable( idle && !m_signingIn );
    m_newButton->Enable( idle && !m_signingIn );
    m_trashButton->Enable( idle && m_signedIn );
    m_refreshButton->Enable( idle );
    m_signInButton->Enable( idle || m_signingIn );

    // The copy being written must not be abandoned half-way.
    for( int closeId : { wxID_CLOSE, wxID_CANCEL } )
    {
        if( wxWindow* closeButton = FindWindow( closeId ) )
            closeButton->Enable( !m_downloading && !m_publishing );
    }

    wxString publicLabel = project && jsonBool( *project, "public" ) ? _( "Make Private" )
                                                                     : _( "Make Public" );

    if( m_publicButton->GetLabel() != publicLabel )
        m_publicButton->SetLabel( publicLabel );

    // Only the owner can delete; everyone else can walk away from the project.
    wxString deleteLabel = _( "Move to Trash..." );

    if( m_showTrash )
        deleteLabel = _( "Delete Permanently..." );
    else if( project && knowMe && !owner )
        deleteLabel = _( "Leave..." );

    if( m_deleteButton->GetLabel() != deleteLabel )
    {
        m_deleteButton->SetLabel( deleteLabel );
        Layout();
    }
}


void DIALOG_ONLINE_PROJECTS::updateStatus()
{
    wxString text;
    wxString filter = m_search->GetValue();
    bool     undo = false;

    filter.Trim( true ).Trim( false );

    if( m_busy > 0 )
    {
        text = m_busyText;
    }
    else if( m_signingIn )
    {
        text = _( "Finish signing in in your web browser, or choose Cancel Sign-In to start "
                  "over." );
    }
    else if( !m_notice.IsEmpty() )
    {
        text = m_notice;
        undo = !m_undoProjectId.IsEmpty();
    }
    else if( !m_signedIn )
    {
        text = _( "Sign in to see your online projects." );
    }
    else if( m_loadFailed )
    {
        // A listing that is not there is a server that does not have it (an older one
        // has no Trash) or an address that is not a collaboration server: the general
        // wording for 404 is about a single project.
        wxString reason = m_loadError.status == 404
                                  ? _( "The server does not offer this.  Check the server "
                                       "address, or update the server." )
                                  : COLLAB_REST::DescribeError( m_loadError );

        text = wxString::Format( m_showTrash ? _( "Could not load the Trash from %s.  %s" )
                                             : _( "Could not load your projects from %s.  %s" ),
                                 COLLAB_SESSION::ServerUrl(), reason );
    }
    else if( !m_loaded )
    {
        text = wxEmptyString;
    }
    else if( m_showTrash && m_allProjects.empty() )
    {
        text = _( "The Trash is empty.  Projects you delete stay here for 30 days." );
    }
    else if( m_myUserId < 0 && !m_showTrash )
    {
        text = wxString::Format( _( "Could not load your account details from %s.  Projects "
                                    "can be opened, but press Refresh before managing them." ),
                                 COLLAB_SESSION::ServerUrl() );
    }
    else if( m_allProjects.empty() )
    {
        // Only suggest what can be done right now.
        if( m_publishBlocked.IsEmpty() )
        {
            text = _( "No online projects yet.  Choose New Online Project to publish the "
                      "current project or start a blank one, or join one from a share link." );
        }
        else
        {
            text = _( "No online projects yet.  Choose New Online Project to start a blank "
                      "one, or join one from a share link.  To publish a project of yours, "
                      "open it first." );
        }
    }
    else if( m_projects.empty() )
    {
        text = wxString::Format( _( "No projects match '%s'.  Press Escape to clear the "
                                    "filter." ),
                                 filter );
    }
    else if( m_showTrash )
    {
        text = wxString::Format( _( "Projects in the Trash: %d.  Restore a project to get it "
                                    "back for everyone who had access." ),
                                 (int) m_projects.size() );
    }
    else if( m_projects.size() != m_allProjects.size() )
    {
        text = wxString::Format( _( "Showing %d of %d projects.  Double-click a project to "
                                    "open it." ),
                                 (int) m_projects.size(), (int) m_allProjects.size() );
    }
    else
    {
        text = wxString::Format( _( "Projects: %d.  Double-click a project to open it." ),
                                 (int) m_projects.size() );
    }

    // Project names, folders and the filter are in there: as text, so that an '&' in
    // "R&D board" is not taken for a mnemonic.
    if( m_statusLabel->GetLabelText() != text )
        m_statusLabel->SetLabelText( text );

    if( m_undoButton->IsShown() != undo )
    {
        m_undoButton->Show( undo );
        Layout();
    }
}


void DIALOG_ONLINE_PROJECTS::clearNotice()
{
    m_notice.clear();
    m_undoProjectId.clear();
    m_undoProjectName.clear();
}


void DIALOG_ONLINE_PROJECTS::showFailure( const wxString& aWhat, const wxString& aTitle,
                                          const COLLAB_REST::ERROR_INFO& aError )
{
    wxMessageBox( aWhat + wxS( "\n\n" ) + COLLAB_REST::DescribeError( aError ), aTitle,
                  wxOK | wxICON_ERROR, this );
}


void DIALOG_ONLINE_PROJECTS::setNotice( const wxString& aNotice, const wxString& aUndoProjectId,
                                        const wxString& aUndoProjectName )
{
    m_notice = aNotice;
    m_undoProjectId = aUndoProjectId;
    m_undoProjectName = aUndoProjectName;
    updateStatus();
}


void DIALOG_ONLINE_PROJECTS::beginBusy( const wxString& aStatus )
{
    m_busy++;
    m_busyText = aStatus;

    updateStatus();
    updateControls();
}


void DIALOG_ONLINE_PROJECTS::endBusy()
{
    if( m_busy > 0 )
        m_busy--;

    updateStatus();
    updateControls();
}


void DIALOG_ONLINE_PROJECTS::runAsync( const wxString& aStatus, ASYNC_WORK aWork,
                                       ASYNC_DONE aDone )
{
    wxString server = COLLAB_SESSION::ServerUrl();

    // A new action: what the last one had to say is history.  (Reloading the list is
    // not one, so that an action can leave a notice and reload.)
    clearNotice();
    beginBusy( aStatus );

    // Off the UI thread: a slow or unreachable server must not freeze the
    // dialog for the whole curl timeout.
    std::shared_ptr<bool> alive = m_alive;
    std::string           serverStd = server.ToStdString( wxConvUTF8 );
    std::string           tokenStd = COLLAB_AUTH::StoredToken( server ).ToStdString( wxConvUTF8 );

    // Written by the worker, read by the completion: never by both at once.
    std::shared_ptr<COLLAB_REST::ERROR_INFO> error = std::make_shared<COLLAB_REST::ERROR_INFO>();

    COLLAB_SESSION::Get().RunAsync(
            [this, alive, serverStd, tokenStd, error, aWork, aDone]()
            {
                // The completion must be queued whatever happens, or the dialog
                // would stay busy for good: the worker swallows exceptions.
                bool ok = false;

                try
                {
                    ok = aWork( wxString::FromUTF8( serverStd ), wxString::FromUTF8( tokenStd ),
                                *error );
                }
                catch( ... )
                {
                    ok = false;
                    error->status = -1;
                    error->message = _( "An unexpected error occurred." );
                }

                wxTheApp->CallAfter(
                        [this, alive, ok, error, aDone]()
                        {
                            if( !*alive )
                                return;

                            endBusy();
                            aDone( ok, *error );
                        } );
            } );
}


void DIALOG_ONLINE_PROJECTS::refresh()
{
    wxString server = COLLAB_SESSION::ServerUrl();
    wxString token = COLLAB_AUTH::StoredToken( server );

    // Anything still in flight from an earlier refresh is stale now.
    int generation = ++m_refreshGeneration;

    m_signedIn = !token.IsEmpty();

    if( !m_signedIn )
    {
        m_allProjects.clear();
        m_localCopies.clear();
        m_myLogin.clear();
        m_myUserId = -1;
        m_loaded = false;
        m_loadFailed = false;
        m_selectAfterRefresh.clear();

        // The Trash is somebody's; signed out it is nobody's.
        if( m_showTrash )
        {
            m_showTrash = false;
            applyViewMode();
        }

        updateSignInState();
        applyFilter();
        return;
    }

    // The rows on screen stay put while the fresh listing loads; the same
    // project is selected again once it arrives.
    if( m_selectAfterRefresh.IsEmpty() )
        m_selectAfterRefresh = selectedProjectId();

    updateSignInState();
    beginBusy( m_showTrash ? _( "Loading the Trash..." )
                           : _( "Loading your online projects..." ) );

    // Fetch off the UI thread: an unreachable server must not freeze the
    // dialog for the whole curl timeout.
    std::shared_ptr<bool> alive = m_alive;
    std::string           serverStd = server.ToStdString( wxConvUTF8 );
    std::string           tokenStd = token.ToStdString( wxConvUTF8 );
    bool                  trash = m_showTrash;

    // Written by the worker, read by the completion: never by both at once.
    std::shared_ptr<COLLAB_REST::ERROR_INFO> error = std::make_shared<COLLAB_REST::ERROR_INFO>();

    COLLAB_SESSION::Get().RunAsync(
            [this, alive, generation, serverStd, tokenStd, trash, error]()
            {
                nlohmann::json meJson = nlohmann::json::object();
                nlohmann::json listingJson = nlohmann::json::object();
                bool           meOk = false;
                bool           listingOk = false;

                // The completion below must be queued whatever happens: the
                // worker swallows exceptions and the dialog would stay busy.
                try
                {
                    wxString serverUrl = wxString::FromUTF8( serverStd );
                    wxString bearer = wxString::FromUTF8( tokenStd );

                    std::optional<nlohmann::json> me = COLLAB_REST::Me( serverUrl, bearer );
                    std::optional<nlohmann::json> listing =
                            trash ? COLLAB_REST::ListTrash( serverUrl, bearer, error.get() )
                                  : COLLAB_REST::ListProjects( serverUrl, bearer, error.get() );

                    if( me )
                    {
                        meJson = *me;
                        meOk = true;
                    }

                    if( listing )
                    {
                        listingJson = *listing;
                        listingOk = true;
                    }
                }
                catch( ... )
                {
                    listingJson = nlohmann::json::object();
                    listingOk = false;
                    error->status = -1;
                    error->message = _( "An unexpected error occurred." );
                }

                wxTheApp->CallAfter(
                        [this, alive, generation, meJson, meOk, listingJson, listingOk, error]()
                        {
                            if( !*alive )
                                return;

                            endBusy();

                            if( generation != m_refreshGeneration )
                                return;

                            populate( meJson, meOk, listingJson, listingOk, *error );
                        } );
            } );
}


void DIALOG_ONLINE_PROJECTS::populate( const nlohmann::json& aMe, bool aMeOk,
                                       const nlohmann::json& aListing, bool aListingOk,
                                       const COLLAB_REST::ERROR_INFO& aListingError )
{
    // A failed /api/me keeps what an earlier refresh learned (signing out resets
    // it): guessing "not the owner" would turn Delete into a Leave that the
    // server refuses.
    if( aMeOk )
    {
        m_myLogin = jsonStr( aMe, "login" );
        m_myUserId = jsonInt( aMe, "id", -1LL );
    }

    m_loaded = true;
    m_loadFailed = !aListingOk;
    m_loadError = aListingError;

    m_allProjects.clear();
    m_localCopies.clear();

    if( aListingOk && aListing.is_object() && aListing.contains( "projects" )
        && aListing[ "projects" ].is_array() )
    {
        for( const nlohmann::json& project : aListing[ "projects" ] )
        {
            wxString projectId = jsonStr( project, "projectId" );

            if( projectId.IsEmpty() )
                continue;

            m_allProjects.push_back( project );

            // Looked up once per listing rather than per keystroke in the filter.
            wxString localCopy = COLLAB_PROJECT::FindLocalCopy( projectId );

            if( !localCopy.IsEmpty() )
                m_localCopies[ projectId ] = localCopy;
        }
    }

    // Starred projects lead, as on the web; within each group the server's order
    // (most recently edited first) stands until a column header says otherwise.
    std::stable_partition( m_allProjects.begin(), m_allProjects.end(),
                           []( const nlohmann::json& aProject )
                           {
                               return jsonBool( aProject, "starred" );
                           } );

    wxString select = m_selectAfterRefresh;
    m_selectAfterRefresh.clear();

    updateSignInState();
    applyFilter( select );
}


void DIALOG_ONLINE_PROJECTS::applyFilter( const wxString& aSelectProjectId )
{
    wxString keepId = aSelectProjectId.IsEmpty() ? selectedProjectId() : aSelectProjectId;
    int      previousRow = m_list->GetSelectedRow();
    wxString needle = m_search->GetValue();

    needle.Trim( true ).Trim( false );
    needle.MakeLower();

    std::vector<wxVector<wxVariant>>            rows;
    std::vector<ONLINE_PROJECT_STORE::SORT_KEY> keys;

    m_projects.clear();

    int selectRow = wxNOT_FOUND;

    for( const nlohmann::json& project : m_allProjects )
    {
        wxString projectId = jsonStr( project, "projectId" );
        wxString name = jsonStr( project, "name" );
        wxString owner = jsonStr( project, "ownerLogin" );
        wxString description = jsonStr( project, "description" );
        wxString edited = jsonStr( project, m_showTrash ? "deletedAt" : "updatedAt" );
        bool     starred = jsonBool( project, "starred" );
        bool     localCopy = m_localCopies.count( projectId ) > 0;

        if( !needle.IsEmpty() && !name.Lower().Contains( needle )
            && !owner.Lower().Contains( needle ) && !description.Lower().Contains( needle ) )
        {
            continue;
        }

        bool mine = m_myUserId >= 0 && jsonInt( project, "ownerId", -1LL ) == m_myUserId;

        // Only one's own projects are ever in one's Trash.
        if( mine || m_showTrash )
            owner = _( "you" );

        // Keep the description on one line; the column is only a hint.
        description.Replace( wxS( "\r" ), wxS( " " ) );
        description.Replace( wxS( "\n" ), wxS( " " ) );

        // In the Trash that column says when the project is gone for good.
        if( m_showTrash )
            description = jsonStr( project, "purgeAt" ).Left( 10 );

        // In the order of ONLINE_PROJECT_COLUMN.
        wxVector<wxVariant> row;
        row.push_back( wxVariant( starred ? starMark() : wxString() ) );
        row.push_back( wxVariant( name ) );
        row.push_back( wxVariant( owner ) );

        // The listing reports the owner's role as "editor"; the share sheet calls that
        // person the owner, and so does this list.
        row.push_back( wxVariant( mine ? DIALOG_SHARE_PROJECT::RoleLabel( wxS( "owner" ) )
                                       : DIALOG_SHARE_PROJECT::RoleLabel(
                                                 jsonStr( project, "role" ) ) ) );
        row.push_back( wxVariant( jsonBool( project, "public" ) ? _( "public" )
                                                                : _( "private" ) ) );
        row.push_back( wxVariant( localCopy ? _( "On this computer" ) : wxString() ) );
        row.push_back( wxVariant( wxString::Format( wxS( "%lld" ),
                                                    jsonInt( project, "docCount", 0LL ) ) ) );
        row.push_back( wxVariant( prettyTimestamp( edited ) ) );
        row.push_back( wxVariant( description ) );

        ONLINE_PROJECT_STORE::SORT_KEY key;
        key.starred = starred;
        key.localCopy = localCopy;
        key.name = name;
        key.owner = owner;
        key.edited = edited;

        if( !keepId.IsEmpty() && projectId == keepId )
            selectRow = (int) m_projects.size();

        rows.push_back( row );
        keys.push_back( key );
        m_projects.push_back( project );
    }

    // The project that was selected is gone (deleted, left or filtered out):
    // stay near where the selection was rather than dropping it.
    if( selectRow == wxNOT_FOUND && !m_projects.empty() )
    {
        selectRow = previousRow == wxNOT_FOUND ? 0 : previousRow;
        selectRow = std::max( 0, std::min( selectRow, (int) m_projects.size() - 1 ) );
    }

    // Rebuilding the rows is not the user choosing something: see onSelectionChanged().
    m_populating = true;

    // The sort keys go in first: a sorted list asks for them as each row arrives.
    m_list->DeleteAllItems();
    m_store->SetSortKeys( keys );

    for( const wxVector<wxVariant>& row : rows )
        m_list->AppendItem( row );

    if( selectRow != wxNOT_FOUND )
    {
        m_list->SelectRow( selectRow );
        m_list->EnsureVisible( m_list->RowToItem( selectRow ) );
    }

    m_populating = false;

    updateStatus();
    updateControls();
}


const nlohmann::json* DIALOG_ONLINE_PROJECTS::selectedProject() const
{
    int row = m_list->GetSelectedRow();

    if( row == wxNOT_FOUND || row < 0 || row >= (int) m_projects.size() )
        return nullptr;

    return &m_projects[ row ];
}


wxString DIALOG_ONLINE_PROJECTS::selectedProjectId() const
{
    const nlohmann::json* project = selectedProject();

    return project ? jsonStr( *project, "projectId" ) : wxString();
}


bool DIALOG_ONLINE_PROJECTS::ownsSelected() const
{
    const nlohmann::json* project = selectedProject();

    return project && m_myUserId >= 0 && jsonInt( *project, "ownerId", -1LL ) == m_myUserId;
}


void DIALOG_ONLINE_PROJECTS::clearFilter()
{
    m_search->ChangeValue( wxEmptyString );
    clearNotice();
    applyFilter();
}


void DIALOG_ONLINE_PROJECTS::OnCharHook( wxKeyEvent& aEvt )
{
    int       key = aEvt.GetKeyCode();
    bool      plain = aEvt.GetModifiers() == wxMOD_NONE;
    wxWindow* focus = wxWindow::FindFocus();
    bool      inList = focus && ( focus == m_list || m_list->IsDescendant( focus ) );
    bool      inSearch = focus && ( focus == m_search || m_search->IsDescendant( focus ) );

    wxCommandEvent dummy;

    // Escape would close the dialog under the copy being written, or the upload.
    if( key == WXK_ESCAPE && ( m_downloading || m_publishing ) )
        return;

    // The first Escape takes a filter away, wherever the focus is (the status line says
    // so when nothing matches); only the next one closes the dialog.
    if( key == WXK_ESCAPE && plain && !m_search->GetValue().IsEmpty() )
    {
        clearFilter();
        return;
    }

    if( key == WXK_F5 && plain )
    {
        onRefresh( dummy );
        return;
    }

    if( key == WXK_F2 && plain && inList )
    {
        onRename( dummy );
        return;
    }

    // wxMOD_CONTROL is Cmd on macOS.
    if( key == 'F' && aEvt.GetModifiers() == wxMOD_CONTROL )
    {
        m_search->SetFocus();
        m_search->SelectAll();
        return;
    }

    if( ( key == WXK_RETURN || key == WXK_NUMPAD_ENTER ) && plain )
    {
        if( inList )
        {
            onOpen( dummy );
            return;
        }

        // Enter in the filter: straight in when it narrowed things down to one
        // project, otherwise on to the list to pick one.  (Not in the Trash, where
        // "in" would be restoring something on the strength of a filter.)
        if( inSearch )
        {
            if( m_projects.size() == 1 && !m_showTrash )
                onOpen( dummy );
            else if( !m_projects.empty() )
                m_list->SetFocus();

            return;
        }
    }

    if( key == WXK_DOWN && plain && inSearch && !m_projects.empty() )
    {
        m_list->SetFocus();
        return;
    }

    if( ( key == WXK_DELETE || key == WXK_NUMPAD_DELETE ) && plain && inList )
    {
        onDelete( dummy );
        return;
    }

    DIALOG_SHIM::OnCharHook( aEvt );
}


void DIALOG_ONLINE_PROJECTS::onClose( wxCloseEvent& aEvent )
{
    // Closing mid-download would leave a folder nothing knows to be a copy of
    // the project; the next Open would then fetch a second one beside it.
    //
    // Closing mid-publish would leave the project online with nothing here knowing
    // that this folder is its copy: it could then be published a second time.
    if( ( m_downloading || m_publishing ) && aEvent.CanVeto() )
    {
        aEvent.Veto();
        return;
    }

    aEvent.Skip();
}


void DIALOG_ONLINE_PROJECTS::startSignIn( std::function<void()> aThen )
{
    // One browser sign-in at a time.  Everything that would ask for another is
    // unavailable until the pending one is through or cancelled.
    if( m_signingIn )
        return;

    wxString server = COLLAB_SESSION::ServerUrl();
    wxString error;

    m_afterSignIn = aThen;

    bool started = m_auth->SignIn( server,
            [this]( bool aSuccess, const wxString& aTokenOrError )
            {
                std::function<void()> then = m_afterSignIn;

                m_afterSignIn = nullptr;
                m_signingIn = false;

                updateSignInState();
                updateStatus();
                updateControls();

                if( aSuccess )
                {
                    refresh();

                    if( then )
                        then();
                }
                else
                {
                    wxMessageBox( aTokenOrError, _( "Sign In" ), wxOK | wxICON_ERROR, this );
                }
            },
            error );

    if( !started )
    {
        m_afterSignIn = nullptr;
        wxMessageBox( error, _( "Sign In" ), wxOK | wxICON_ERROR, this );
        return;
    }

    m_signingIn = true;
    clearNotice();

    updateSignInState();
    updateStatus();
    updateControls();
}


void DIALOG_ONLINE_PROJECTS::cancelSignIn()
{
    if( !m_signingIn )
        return;

    // The browser never tells us that its tab was closed or that the page did not
    // load; left alone, the attempt would sit there until its listener times out
    // minutes later.  Dropping the COLLAB_AUTH takes that listener, and the completion
    // waiting on it, away at once, and the fresh one can start over.
    m_auth = std::make_unique<COLLAB_AUTH>();

    m_afterSignIn = nullptr;
    m_signingIn = false;

    updateSignInState();
    updateControls();
    setNotice( _( "Sign-in cancelled." ) );
}


void DIALOG_ONLINE_PROJECTS::whenSignedIn( std::function<void()> aThen )
{
    if( COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() ).IsEmpty() )
        startSignIn( aThen );
    else
        aThen();
}


void DIALOG_ONLINE_PROJECTS::onSignInOut( wxCommandEvent& aEvent )
{
    if( m_signingIn )
    {
        cancelSignIn();
        return;
    }

    if( m_busy > 0 )
        return;

    if( m_signedIn )
    {
        COLLAB_AUTH::ForgetToken( COLLAB_SESSION::ServerUrl() );
        setNotice( wxEmptyString );
        refresh();
        return;
    }

    startSignIn( nullptr );
}


void DIALOG_ONLINE_PROJECTS::onRefresh( wxCommandEvent& aEvent )
{
    if( m_busy > 0 )
        return;

    // Also the way out of "Not signed in" after signing in somewhere else: refresh()
    // looks for the stored sign-in itself.
    setNotice( wxEmptyString );
    refresh();
}


void DIALOG_ONLINE_PROJECTS::onToggleTrash( wxCommandEvent& )
{
    if( m_busy > 0 || !m_signedIn )
        return;

    setNotice( wxEmptyString );
    showTrash( !m_showTrash );
}


void DIALOG_ONLINE_PROJECTS::onSearchText( wxCommandEvent& aEvent )
{
    clearNotice();
    applyFilter();
}


void DIALOG_ONLINE_PROJECTS::onSelectionChanged( wxDataViewEvent& aEvent )
{
    // Some ports report the selection moving while applyFilter() rebuilds the rows; a
    // notice is only outlived by what the user selects.
    if( m_populating )
        return;

    clearNotice();
    updateStatus();
    updateControls();
}


void DIALOG_ONLINE_PROJECTS::onItemActivated( wxDataViewEvent& aEvent )
{
    wxCommandEvent dummy;
    onOpen( dummy );
}


void DIALOG_ONLINE_PROJECTS::onContextMenu( wxDataViewEvent& aEvent )
{
    // Act on the row under the pointer, like every file manager does.
    if( aEvent.GetItem().IsOk() )
    {
        int row = m_list->ItemToRow( aEvent.GetItem() );

        if( row != wxNOT_FOUND && row != m_list->GetSelectedRow() )
        {
            m_list->SelectRow( row );
            updateControls();
        }
    }

    const nlohmann::json* project = selectedProject();

    if( !project || m_busy > 0 )
        return;

    bool owner = ownsSelected();

    wxMenu menu;

    if( m_showTrash )
    {
        menu.Append( ID_ONLINE_RESTORE, _( "Restore" ) );
        menu.AppendSeparator();
        menu.Append( ID_ONLINE_DELETE_OR_LEAVE, _( "Delete Permanently..." ) );
    }
    else
    {
        menu.Append( ID_ONLINE_OPEN, _( "Open" ) );
        menu.Append( ID_ONLINE_OPEN_IN_FOLDER, _( "Open in Folder..." ) );
        menu.Append( ID_ONLINE_OPEN_IN_BROWSER, _( "Open in Web Browser" ) );
        menu.AppendSeparator();
        menu.Append( ID_ONLINE_SHARE, _( "Share..." ) );
        menu.Append( ID_ONLINE_COPY_WEB_LINK, _( "Copy Web Link" ) );
        menu.AppendSeparator();
        menu.Append( ID_ONLINE_TOGGLE_STAR,
                     jsonBool( *project, "starred" ) ? _( "Remove Star" ) : _( "Add Star" ) );
        menu.Append( ID_ONLINE_DETAILS, _( "Project Details..." ) );
        menu.Append( ID_ONLINE_RENAME, _( "Rename..." ) + wxS( "\tF2" ) );
        menu.Append( ID_ONLINE_TOGGLE_PUBLIC,
                     jsonBool( *project, "public" ) ? _( "Make Private" ) : _( "Make Public" ) );
        menu.Append( ID_ONLINE_MAKE_COPY, _( "Make a Copy" ) );
        menu.AppendSeparator();
        menu.Append( ID_ONLINE_DELETE_OR_LEAVE,
                     owner || m_myUserId < 0 ? _( "Move to Trash..." ) : _( "Leave..." ) );

        menu.Enable( ID_ONLINE_DETAILS, owner );
        menu.Enable( ID_ONLINE_RENAME, owner );
        menu.Enable( ID_ONLINE_TOGGLE_PUBLIC, owner );

        // Owner or member is unknown until /api/me answers; see updateControls().
        menu.Enable( ID_ONLINE_DELETE_OR_LEAVE, m_myUserId >= 0 );
    }

    // The selection is read again by each handler, so nothing here outlives the menu.
    int command = GetPopupMenuSelectionFromUser( menu );

    wxCommandEvent dummy;

    switch( command )
    {
    case ID_ONLINE_OPEN:
    case ID_ONLINE_RESTORE:         onOpen( dummy );          break;
    case ID_ONLINE_OPEN_IN_FOLDER:  onOpenInFolder( dummy );  break;
    case ID_ONLINE_OPEN_IN_BROWSER: onOpenInBrowser( dummy ); break;
    case ID_ONLINE_SHARE:           onShare( dummy );         break;
    case ID_ONLINE_COPY_WEB_LINK:   onCopyWebLink( dummy );   break;
    case ID_ONLINE_TOGGLE_STAR:     onToggleStar( dummy );    break;
    case ID_ONLINE_DETAILS:         onDetails( dummy );       break;
    case ID_ONLINE_RENAME:          onRename( dummy );        break;
    case ID_ONLINE_TOGGLE_PUBLIC:   onTogglePublic( dummy );  break;
    case ID_ONLINE_MAKE_COPY:       onMakeCopy( dummy );      break;
    case ID_ONLINE_DELETE_OR_LEAVE: onDelete( dummy );        break;
    default:                                                  break;
    }
}


void DIALOG_ONLINE_PROJECTS::onOpen( wxCommandEvent& aEvent )
{
    if( m_busy > 0 )
        return;

    if( const nlohmann::json* project = selectedProject() )
    {
        // What is in the Trash can only be taken back out.
        if( m_showTrash )
        {
            restoreProject( jsonStr( *project, "projectId" ), jsonStr( *project, "name" ) );
            return;
        }

        // A copy: the row must not be relied on across the dialogs openProject() shows.
        nlohmann::json copy = *project;
        openProject( copy );
    }
}


void DIALOG_ONLINE_PROJECTS::onOpenInFolder( wxCommandEvent& aEvent )
{
    if( m_busy > 0 || m_showTrash )
        return;

    if( const nlohmann::json* project = selectedProject() )
    {
        nlohmann::json copy = *project;
        openProject( copy, /* aChooseFolder */ true );
    }
}


void DIALOG_ONLINE_PROJECTS::openProject( const nlohmann::json& aProject, bool aChooseFolder )
{
    wxString server = COLLAB_SESSION::ServerUrl();
    wxString token = COLLAB_AUTH::StoredToken( server );
    wxString projectId = jsonStr( aProject, "projectId" );
    wxString name = jsonStr( aProject, "name" );

    if( token.IsEmpty() || projectId.IsEmpty() )
        return;

    if( name.IsEmpty() )
        name = wxS( "untitled" );

    // Opened before?  Reuse the recorded copy without asking for a directory
    // or downloading anything; local edits replay from the journal on join.
    wxString recorded = COLLAB_PROJECT::FindLocalCopy( projectId );

    if( !recorded.IsEmpty() )
    {
        if( !aChooseFolder )
        {
            m_projectToOpen = recorded;
            EndModal( wxID_OK );
            return;
        }

        int answer = wxMessageBox( wxString::Format( _( "'%s' already has a local copy on this "
                                                        "computer:\n\n%s\n\nDownload another "
                                                        "copy into a different folder?\n\n"
                                                        "Choose No to open the existing copy." ),
                                                     name, recorded ),
                                   _( "Open Online Project" ),
                                   wxYES_NO | wxCANCEL | wxNO_DEFAULT | wxICON_QUESTION, this );

        if( answer == wxNO )
        {
            m_projectToOpen = recorded;
            EndModal( wxID_OK );
            return;
        }

        if( answer != wxYES )
            return;
    }

    // Default local home for cloud copies; "Open In Folder..." puts it elsewhere.
    wxFileName base( PATHS::GetDefaultUserProjectsPath(), wxEmptyString );
    base.AppendDir( wxS( "Cloud" ) );

    wxString dirName = sanitizeDirName( name );
    wxString parentDir = base.GetPath();
    wxString targetDir;
    wxString existingPro;

    if( aChooseFolder )
    {
        wxDirDialog dirDlg( this, _( "Folder to store the local copy in" ), base.GetPath(),
                            wxDD_DEFAULT_STYLE );

        if( dirDlg.ShowModal() != wxID_OK )
            return;

        wxString   chosen = dirDlg.GetPath();
        wxFileName chosenDir( chosen, wxEmptyString );

        // Picking (or creating) a folder already named after the project is the
        // natural thing to do in the directory dialog; don't nest <name>/<name>/
        // when that folder is free or already is this project's copy.
        if( !chosenDir.GetDirs().IsEmpty() && chosenDir.GetDirs().Last() == dirName )
        {
            existingPro = linkedProFile( chosen, projectId );

            if( !existingPro.IsEmpty() || dirIsEmpty( chosen )
                || dirIsProLessCopy( chosen, dirName, projectId ) )
            {
                targetDir = chosen;
            }
        }

        parentDir = chosen;

        // The chosen folder itself is the copy: it sits in the folder above it.
        if( !targetDir.IsEmpty() )
        {
            chosenDir.RemoveLastDir();
            parentDir = chosenDir.GetPath();
        }
    }

    // Never download over a folder that holds something else: an unrelated
    // "<name>" is left alone and the copy goes to "<name> (2)" beside it.
    if( targetDir.IsEmpty() )
        targetDir = pickTargetDir( parentDir, dirName, projectId, existingPro );

    // Nothing is ever written anywhere but into one folder directly inside the folder
    // meant to hold it, whatever the project is called online.
    if( targetDir.IsEmpty() || !isDirectChildDir( parentDir, targetDir ) )
    {
        wxMessageBox( wxString::Format( _( "No free folder name for '%s' was found in\n%s" ),
                                        name, parentDir ),
                      _( "Open Online Project" ), wxOK | wxICON_ERROR, this );
        return;
    }

    // An existing local copy the registry had lost track of: skip the download,
    // keep local edits (they replay from the journal when the session reconnects).
    if( !existingPro.IsEmpty() )
    {
        COLLAB_PROJECT::RecordLocalCopy( projectId, existingPro );
        m_projectToOpen = existingPro;
        EndModal( wxID_OK );
        return;
    }

    // An earlier download of this project that had no .kicad_pro in it: fetch
    // into the same folder rather than piling up "<name> (2)", "(3)"..., but
    // only on the user's say-so since the files there get replaced.
    if( wxFileName::DirExists( targetDir ) && !dirIsEmpty( targetDir ) )
    {
        if( wxMessageBox( wxString::Format( _( "'%s' was downloaded before to\n\n%s\n\nbut "
                                               "had no .kicad_pro file to open.  Download it "
                                               "again?\n\nFiles in that folder are replaced "
                                               "by the online versions." ),
                                            name, targetDir ),
                          _( "Open Online Project" ), wxYES_NO | wxNO_DEFAULT | wxICON_QUESTION,
                          this )
            != wxYES )
        {
            return;
        }
    }

    std::shared_ptr<std::string> proFileOut = std::make_shared<std::string>();
    std::shared_ptr<std::string> errorOut = std::make_shared<std::string>();

    std::string projectIdStd = projectId.ToStdString( wxConvUTF8 );
    std::string dirNameStd = dirName.ToStdString( wxConvUTF8 );
    std::string targetDirStd = targetDir.ToStdString( wxConvUTF8 );

    // No closing the dialog while the copy is written: see onClose().
    m_downloading = true;

    runAsync( wxString::Format( _( "Downloading '%s' to %s..." ), name, targetDir ),
            [projectIdStd, dirNameStd, targetDirStd, proFileOut, errorOut](
                    const wxString& aServer, const wxString& aToken, COLLAB_REST::ERROR_INFO& )
            {
                wxString proFile;
                wxString error;

                bool ok = COLLAB_PROJECT::DownloadAndExtract( aServer, aToken,
                                                              wxString::FromUTF8( projectIdStd ),
                                                              wxString::FromUTF8( dirNameStd ),
                                                              wxString::FromUTF8( targetDirStd ),
                                                              proFile, error );

                *proFileOut = proFile.ToStdString( wxConvUTF8 );
                *errorOut = error.ToStdString( wxConvUTF8 );

                return ok;
            },
            [this, projectIdStd, targetDirStd, proFileOut, errorOut](
                    bool aOk, const COLLAB_REST::ERROR_INFO& )
            {
                m_downloading = false;
                updateControls();

                if( !aOk )
                {
                    // An exception in the worker leaves no message behind.
                    wxString error = wxString::FromUTF8( *errorOut );

                    if( error.IsEmpty() )
                        error = _( "Unable to download the shared project." );

                    wxMessageBox( error, _( "Open Online Project" ), wxOK | wxICON_ERROR, this );
                    return;
                }

                wxString proFile = wxString::FromUTF8( *proFileOut );

                if( proFile.IsEmpty() )
                {
                    wxMessageBox( wxString::Format( _( "The project contains no .kicad_pro "
                                                       "file, so it cannot be opened here.  "
                                                       "Its files were downloaded to\n\n%s" ),
                                                    wxString::FromUTF8( targetDirStd ) ),
                                  _( "Open Online Project" ), wxOK | wxICON_ERROR, this );
                    return;
                }

                COLLAB_PROJECT::RecordLocalCopy( wxString::FromUTF8( projectIdStd ), proFile );
                m_projectToOpen = proFile;
                EndModal( wxID_OK );
            } );
}


void DIALOG_ONLINE_PROJECTS::onShare( wxCommandEvent& aEvent )
{
    const nlohmann::json* project = selectedProject();

    if( !project || m_busy > 0 || m_showTrash )
        return;

    wxString projectId = jsonStr( *project, "projectId" );

    // Members who are not the owner still get to see who has access; the
    // share sheet opens read-only for them.
    DIALOG_SHARE_PROJECT dlg( this, projectId, jsonStr( *project, "name" ), ownsSelected(),
                              jsonBool( *project, "public" ) );
    dlg.ShowModal();

    // A new owner or a new visibility shows in this list as well.
    if( dlg.ProjectChanged() )
    {
        m_selectAfterRefresh = projectId;
        refresh();
    }
}


void DIALOG_ONLINE_PROJECTS::onCopyWebLink( wxCommandEvent& aEvent )
{
    wxString projectId = selectedProjectId();

    if( projectId.IsEmpty() || m_showTrash )
        return;

    wxString url = projectWebUrl( projectId );

    if( copyToClipboard( url ) )
        setNotice( wxString::Format( _( "Copied %s to the clipboard." ), url ) );
    else
        setNotice( _( "The clipboard is not available." ) );
}


void DIALOG_ONLINE_PROJECTS::onOpenInBrowser( wxCommandEvent& )
{
    wxString projectId = selectedProjectId();

    if( projectId.IsEmpty() || m_showTrash )
        return;

    wxString url = projectWebUrl( projectId );

    if( wxLaunchDefaultBrowser( url ) )
        setNotice( wxString::Format( _( "Opened %s in your web browser." ), url ) );
    else
        setNotice( wxString::Format( _( "Could not open a web browser for %s." ), url ) );
}


void DIALOG_ONLINE_PROJECTS::onRename( wxCommandEvent& aEvent )
{
    const nlohmann::json* project = selectedProject();

    if( !project || !ownsSelected() || m_busy > 0 || m_showTrash )
        return;

    wxString          projectId = jsonStr( *project, "projectId" );
    wxString          current = jsonStr( *project, "name" );
    wxTextEntryDialog dlg( this, _( "New project name:" ), _( "Rename Online Project" ),
                           current );

    dlg.SetMaxLength( MAX_PROJECT_NAME_CHARS );

    if( dlg.ShowModal() != wxID_OK )
        return;

    wxString newName = dlg.GetValue();

    newName.Trim( true ).Trim( false );

    if( newName.IsEmpty() || newName == current )
        return;

    std::string projectIdStd = projectId.ToStdString( wxConvUTF8 );
    std::string newNameStd = newName.ToStdString( wxConvUTF8 );

    m_selectAfterRefresh = projectId;

    runAsync( wxString::Format( _( "Renaming '%s'..." ), current ),
            [projectIdStd, newNameStd]( const wxString& aServer, const wxString& aToken,
                                        COLLAB_REST::ERROR_INFO& aError )
            {
                return COLLAB_REST::RenameProject( aServer, aToken,
                                                   wxString::FromUTF8( projectIdStd ),
                                                   wxString::FromUTF8( newNameStd ), &aError );
            },
            [this]( bool aOk, const COLLAB_REST::ERROR_INFO& aError )
            {
                if( !aOk )
                {
                    showFailure( _( "Renaming the project failed." ),
                                 _( "Rename Online Project" ), aError );
                }

                refresh();
            } );
}


void DIALOG_ONLINE_PROJECTS::onDetails( wxCommandEvent& )
{
    const nlohmann::json* project = selectedProject();

    if( !project || !ownsSelected() || m_busy > 0 || m_showTrash )
        return;

    wxString projectId = jsonStr( *project, "projectId" );
    wxString name = jsonStr( *project, "name" );
    wxString description = jsonStr( *project, "description" );

    DIALOG_ONLINE_PROJECT_DETAILS dlg( this, name, description );

    if( dlg.ShowModal() != wxID_OK )
        return;

    wxString newName = dlg.GetProjectName();
    wxString newDescription = dlg.GetProjectDescription();

    if( newName == name && newDescription == description )
        return;

    std::string projectIdStd = projectId.ToStdString( wxConvUTF8 );
    std::string newNameStd = newName.ToStdString( wxConvUTF8 );
    std::string newDescriptionStd = newDescription.ToStdString( wxConvUTF8 );

    m_selectAfterRefresh = projectId;

    runAsync( wxString::Format( _( "Updating '%s'..." ), name ),
            [projectIdStd, newNameStd, newDescriptionStd]( const wxString& aServer,
                                                          const wxString& aToken,
                                                          COLLAB_REST::ERROR_INFO& aError )
            {
                return COLLAB_REST::UpdateProjectDetails(
                        aServer, aToken, wxString::FromUTF8( projectIdStd ),
                        wxString::FromUTF8( newNameStd ),
                        wxString::FromUTF8( newDescriptionStd ), &aError );
            },
            [this]( bool aOk, const COLLAB_REST::ERROR_INFO& aError )
            {
                if( !aOk )
                {
                    showFailure( _( "Updating the project details failed." ),
                                 _( "Online Project Details" ), aError );
                }

                refresh();
            } );
}


void DIALOG_ONLINE_PROJECTS::onToggleStar( wxCommandEvent& )
{
    const nlohmann::json* project = selectedProject();

    if( !project || m_busy > 0 || m_showTrash )
        return;

    bool     star = !jsonBool( *project, "starred" );
    wxString projectId = jsonStr( *project, "projectId" );
    wxString name = jsonStr( *project, "name" );

    std::string projectIdStd = projectId.ToStdString( wxConvUTF8 );

    m_selectAfterRefresh = projectId;

    runAsync( star ? wxString::Format( _( "Adding a star to '%s'..." ), name )
                   : wxString::Format( _( "Removing the star from '%s'..." ), name ),
            [projectIdStd, star]( const wxString& aServer, const wxString& aToken,
                                  COLLAB_REST::ERROR_INFO& aError )
            {
                return COLLAB_REST::SetStar( aServer, aToken, wxString::FromUTF8( projectIdStd ),
                                             star, &aError );
            },
            [this, star]( bool aOk, const COLLAB_REST::ERROR_INFO& aError )
            {
                if( !aOk )
                {
                    showFailure( star ? _( "Adding the star failed." )
                                      : _( "Removing the star failed." ),
                                 _( "Star Online Project" ), aError );
                }

                refresh();
            } );
}


void DIALOG_ONLINE_PROJECTS::onMakeCopy( wxCommandEvent& )
{
    const nlohmann::json* project = selectedProject();

    if( !project || m_busy > 0 || m_showTrash )
        return;

    wxString name = jsonStr( *project, "name" );

    std::shared_ptr<nlohmann::json> copyOut = std::make_shared<nlohmann::json>();

    std::string projectIdStd = jsonStr( *project, "projectId" ).ToStdString( wxConvUTF8 );

    runAsync( wxString::Format( _( "Making a copy of '%s'..." ), name ),
            [projectIdStd, copyOut]( const wxString& aServer, const wxString& aToken,
                                     COLLAB_REST::ERROR_INFO& aError )
            {
                std::optional<nlohmann::json> copy =
                        COLLAB_REST::CloneProject( aServer, aToken,
                                                   wxString::FromUTF8( projectIdStd ), &aError );

                if( !copy )
                    return false;

                *copyOut = *copy;
                return true;
            },
            [this, copyOut]( bool aOk, const COLLAB_REST::ERROR_INFO& aError )
            {
                if( !aOk )
                {
                    showFailure( _( "Making a copy of the project failed." ),
                                 _( "Copy Online Project" ), aError );
                    return;
                }

                // The copy is a project of its own: private, and the user's.
                m_selectAfterRefresh = jsonStr( *copyOut, "projectId" );
                setNotice( wxString::Format( _( "Created '%s', a private copy that you own." ),
                                             jsonStr( *copyOut, "name" ) ) );
                refresh();
            } );
}


void DIALOG_ONLINE_PROJECTS::onTogglePublic( wxCommandEvent& aEvent )
{
    const nlohmann::json* project = selectedProject();

    if( !project || !ownsSelected() || m_busy > 0 || m_showTrash )
        return;

    bool     makePublic = !jsonBool( *project, "public" );
    wxString projectId = jsonStr( *project, "projectId" );
    wxString name = jsonStr( *project, "name" );

    if( makePublic
        && wxMessageBox( wxString::Format( _( "Make '%s' public?\n\nIt will appear in the "
                                              "server's gallery and anyone can view it, "
                                              "signed in or not.  Members keep their "
                                              "existing roles." ),
                                           name ),
                         _( "Make Project Public" ), wxYES_NO | wxICON_QUESTION, this )
                   != wxYES )
    {
        return;
    }

    std::string projectIdStd = projectId.ToStdString( wxConvUTF8 );

    m_selectAfterRefresh = projectId;

    runAsync( makePublic ? wxString::Format( _( "Making '%s' public..." ), name )
                         : wxString::Format( _( "Making '%s' private..." ), name ),
            [projectIdStd, makePublic]( const wxString& aServer, const wxString& aToken,
                                        COLLAB_REST::ERROR_INFO& aError )
            {
                return COLLAB_REST::SetProjectPublic( aServer, aToken,
                                                      wxString::FromUTF8( projectIdStd ),
                                                      makePublic, &aError );
            },
            [this]( bool aOk, const COLLAB_REST::ERROR_INFO& aError )
            {
                if( !aOk )
                {
                    showFailure( _( "Updating the project visibility failed." ),
                                 _( "Project Visibility" ), aError );
                }

                refresh();
            } );
}


void DIALOG_ONLINE_PROJECTS::onDelete( wxCommandEvent& aEvent )
{
    const nlohmann::json* project = selectedProject();

    if( !project || m_busy > 0 )
        return;

    // In the Trash the only thing left to delete is the project for good.
    if( m_showTrash )
    {
        purgeSelected();
        return;
    }

    if( m_myUserId < 0 )
        return;

    // Deleting is the owner's call; everyone else can only leave.
    if( !ownsSelected() )
    {
        leaveSelected();
        return;
    }

    wxString projectId = jsonStr( *project, "projectId" );
    wxString name = jsonStr( *project, "name" );

    if( wxMessageBox( wxString::Format( _( "Move the online project '%s' to the Trash?\n\n"
                                           "It disappears for every collaborator right away.  "
                                           "You can restore it from the Trash for 30 days; "
                                           "after that it is deleted permanently.  Local "
                                           "copies are not touched." ),
                                        name ),
                      _( "Move Online Project to Trash" ),
                      wxYES_NO | wxNO_DEFAULT | wxICON_QUESTION, this )
        != wxYES )
    {
        return;
    }

    std::string projectIdStd = projectId.ToStdString( wxConvUTF8 );
    std::string nameStd = name.ToStdString( wxConvUTF8 );

    runAsync( wxString::Format( _( "Moving '%s' to the Trash..." ), name ),
            [projectIdStd]( const wxString& aServer, const wxString& aToken,
                            COLLAB_REST::ERROR_INFO& aError )
            {
                return COLLAB_REST::DeleteProject( aServer, aToken,
                                                   wxString::FromUTF8( projectIdStd ), &aError );
            },
            [this, projectIdStd, nameStd]( bool aOk, const COLLAB_REST::ERROR_INFO& aError )
            {
                if( aOk )
                {
                    // Said where it went, with the way back right beside it.
                    wxString name = wxString::FromUTF8( nameStd );

                    setNotice( wxString::Format( _( "'%s' was moved to the Trash.  Choose Show "
                                                    "Trash to restore it later." ),
                                                 name ),
                               wxString::FromUTF8( projectIdStd ), name );
                }
                else
                {
                    showFailure( _( "Moving the project to the Trash failed." ),
                                 _( "Move Online Project to Trash" ), aError );
                }

                refresh();
            } );
}


void DIALOG_ONLINE_PROJECTS::onUndo( wxCommandEvent& )
{
    if( m_busy > 0 || m_undoProjectId.IsEmpty() )
        return;

    // Copies: restoring clears the notice these belong to.
    wxString projectId = m_undoProjectId;
    wxString name = m_undoProjectName;

    restoreProject( projectId, name );
}


void DIALOG_ONLINE_PROJECTS::restoreProject( const wxString& aProjectId, const wxString& aName )
{
    if( m_busy > 0 || aProjectId.IsEmpty() )
        return;

    std::string projectIdStd = aProjectId.ToStdString( wxConvUTF8 );
    std::string nameStd = aName.ToStdString( wxConvUTF8 );

    runAsync( wxString::Format( _( "Restoring '%s'..." ), aName ),
            [projectIdStd]( const wxString& aServer, const wxString& aToken,
                            COLLAB_REST::ERROR_INFO& aError )
            {
                return COLLAB_REST::UndeleteProject( aServer, aToken,
                                                     wxString::FromUTF8( projectIdStd ),
                                                     &aError );
            },
            [this, projectIdStd, nameStd]( bool aOk, const COLLAB_REST::ERROR_INFO& aError )
            {
                if( aOk )
                {
                    setNotice( wxString::Format( _( "'%s' was restored, with everyone's access "
                                                    "as it was." ),
                                                 wxString::FromUTF8( nameStd ) ) );

                    // Back among the projects it is the one to look at.
                    if( !m_showTrash )
                        m_selectAfterRefresh = wxString::FromUTF8( projectIdStd );
                }
                else
                {
                    showFailure( _( "Restoring the project failed." ),
                                 _( "Restore Online Project" ), aError );
                }

                refresh();
            } );
}


void DIALOG_ONLINE_PROJECTS::purgeSelected()
{
    const nlohmann::json* project = selectedProject();

    if( !project || m_busy > 0 || !m_showTrash )
        return;

    wxString name = jsonStr( *project, "name" );

    if( wxMessageBox( wxString::Format( _( "Permanently delete the online project '%s'?\n\n"
                                           "The project and its whole history are destroyed "
                                           "on the server.  This cannot be undone.  Local "
                                           "copies are not touched." ),
                                        name ),
                      _( "Delete Online Project Permanently" ),
                      wxYES_NO | wxNO_DEFAULT | wxICON_WARNING, this )
        != wxYES )
    {
        return;
    }

    std::string projectIdStd = jsonStr( *project, "projectId" ).ToStdString( wxConvUTF8 );
    std::string nameStd = name.ToStdString( wxConvUTF8 );

    runAsync( wxString::Format( _( "Deleting '%s' permanently..." ), name ),
            [projectIdStd]( const wxString& aServer, const wxString& aToken,
                            COLLAB_REST::ERROR_INFO& aError )
            {
                return COLLAB_REST::PurgeProject( aServer, aToken,
                                                  wxString::FromUTF8( projectIdStd ), &aError );
            },
            [this, nameStd]( bool aOk, const COLLAB_REST::ERROR_INFO& aError )
            {
                if( aOk )
                {
                    setNotice( wxString::Format( _( "'%s' was deleted permanently." ),
                                                 wxString::FromUTF8( nameStd ) ) );
                }
                else
                {
                    showFailure( _( "Deleting the project permanently failed." ),
                                 _( "Delete Online Project Permanently" ), aError );
                }

                refresh();
            } );
}


void DIALOG_ONLINE_PROJECTS::leaveSelected()
{
    const nlohmann::json* project = selectedProject();

    if( !project || ownsSelected() || m_busy > 0 || m_myUserId < 0 || m_showTrash )
        return;

    wxString projectId = jsonStr( *project, "projectId" );
    wxString name = jsonStr( *project, "name" );

    if( wxMessageBox( wxString::Format( _( "Leave the online project '%s'?\n\n"
                                           "You lose access until someone invites you again.  "
                                           "The project stays online for everyone else and "
                                           "your local copy is not touched." ),
                                        name ),
                      _( "Leave Online Project" ), wxYES_NO | wxNO_DEFAULT | wxICON_QUESTION,
                      this )
        != wxYES )
    {
        return;
    }

    std::string projectIdStd = projectId.ToStdString( wxConvUTF8 );

    runAsync( wxString::Format( _( "Leaving '%s'..." ), name ),
            [projectIdStd]( const wxString& aServer, const wxString& aToken,
                            COLLAB_REST::ERROR_INFO& aError )
            {
                return COLLAB_REST::LeaveProject( aServer, aToken,
                                                  wxString::FromUTF8( projectIdStd ), &aError );
            },
            [this]( bool aOk, const COLLAB_REST::ERROR_INFO& aError )
            {
                if( !aOk )
                {
                    showFailure( _( "Leaving the project failed." ), _( "Leave Online Project" ),
                                 aError );
                }

                refresh();
            } );
}


void DIALOG_ONLINE_PROJECTS::onNewProject( wxCommandEvent& )
{
    if( m_busy > 0 || m_signingIn )
        return;

    wxMenu menu;
    menu.Append( ID_ONLINE_NEW_PUBLISH, _( "Publish Current Project" ),
                 m_publishBlocked.IsEmpty() ? _( "Upload the project open in the project "
                                                 "manager and keep it in sync from now on" )
                                            : m_publishBlocked );
    menu.Append( ID_ONLINE_NEW_FOLDER, _( "Publish a Folder..." ),
                 _( "Upload a KiCad project from a folder on this computer and keep it in "
                    "sync from now on" ) );
    menu.Append( ID_ONLINE_NEW_BLANK, _( "Blank Project..." ),
                 _( "Start an empty project online and open it" ) );

    // Why it is greyed out is in the button's tooltip: see updatePublishable().
    menu.Enable( ID_ONLINE_NEW_PUBLISH, m_publishBlocked.IsEmpty() );

    switch( m_newButton->GetPopupMenuSelectionFromUser( menu,
                                                        wxPoint( 0, m_newButton->GetSize().y ) ) )
    {
    case ID_ONLINE_NEW_PUBLISH: publishCurrentProject(); break;
    case ID_ONLINE_NEW_FOLDER:  publishFolder();         break;
    case ID_ONLINE_NEW_BLANK:   newBlankProject();       break;
    default:                                             break;
    }
}


void DIALOG_ONLINE_PROJECTS::publishCurrentProject()
{
    if( m_busy > 0 || m_signingIn || !m_publishBlocked.IsEmpty() )
        return;

    // Signed out, the sign-in is ours to run: the frame's own would finish behind this
    // dialog's back and leave it showing "Not signed in" over a published project.
    whenSignedIn(
            [this]()
            {
                uploadCurrentProject();
            } );
}


void DIALOG_ONLINE_PROJECTS::uploadCurrentProject()
{
    // The project manager sits disabled under this dialog, so the project is still the
    // one the menu offered; make sure of it all the same.
    updatePublishable();

    if( m_busy > 0 || !m_publishBlocked.IsEmpty() )
        return;

    PROJECT& project = m_frame->Prj();

    uploadProject( project.GetProjectPath(), project.GetProjectName(),
                   project.GetProjectFullName() );
}


void DIALOG_ONLINE_PROJECTS::publishFolder()
{
    if( m_busy > 0 || m_signingIn )
        return;

    wxDirDialog chooser( this, _( "Choose the folder of the KiCad project to publish" ),
                         PATHS::GetDefaultUserProjectsPath(),
                         wxDD_DEFAULT_STYLE | wxDD_DIR_MUST_EXIST );

    if( chooser.ShowModal() != wxID_OK )
        return;

    wxFileName folder = wxFileName::DirName( chooser.GetPath() );

    // The project is whatever .kicad_pro the folder holds; it is not searched deeper,
    // because a project's own folder is what gets linked and kept in sync.
    wxArrayString proFiles;
    wxDir::GetAllFiles( folder.GetPath(), &proFiles, wxS( "*.kicad_pro" ), wxDIR_FILES );
    proFiles.Sort();

    if( proFiles.IsEmpty() )
    {
        wxMessageBox( _( "That folder has no KiCad project file (.kicad_pro) in it.  Choose "
                         "the folder that holds the project itself." ),
                      _( "Publish a Folder" ), wxOK | wxICON_INFORMATION, this );
        return;
    }

    wxFileName proFile( proFiles[0] );

    if( proFiles.GetCount() > 1 )
    {
        wxArrayString names;

        for( const wxString& file : proFiles )
            names.Add( wxFileName( file ).GetName() );

        int choice = wxGetSingleChoiceIndex( _( "This folder holds more than one project.  "
                                                "Which one do you want to publish?" ),
                                             _( "Publish a Folder" ), names, this );

        if( choice < 0 )
            return;

        proFile = wxFileName( proFiles[choice] );
    }

    // The same form the project manager gives: a path that ends in a separator.
    wxString projectPath = proFile.GetPathWithSep();
    wxString projectName = proFile.GetName();
    wxString linkedServer;

    // One online project per local folder.
    if( !COLLAB_PROJECT::ReadLocalLink( projectPath, projectName, linkedServer ).IsEmpty() )
    {
        wxMessageBox( wxString::Format( _( "'%s' is an online project already.  Open it from "
                                           "the list instead." ),
                                        projectName ),
                      _( "Publish a Folder" ), wxOK | wxICON_INFORMATION, this );
        return;
    }

    wxString fullName = proFile.GetFullPath();

    whenSignedIn(
            [this, projectPath, projectName, fullName]()
            {
                if( m_busy > 0 )
                    return;

                uploadProject( projectPath, projectName, fullName );
            } );
}


void DIALOG_ONLINE_PROJECTS::uploadProject( const wxString& projectPath,
                                            const wxString& projectName,
                                            const wxString& proFile )
{
    std::shared_ptr<nlohmann::json> projectOut = std::make_shared<nlohmann::json>();
    std::shared_ptr<std::string>    urlOut = std::make_shared<std::string>();
    std::shared_ptr<std::string>    errorOut = std::make_shared<std::string>();

    std::string projectPathStd = projectPath.ToStdString( wxConvUTF8 );
    std::string projectNameStd = projectName.ToStdString( wxConvUTF8 );
    std::string proFileStd = proFile.ToStdString( wxConvUTF8 );

    // No closing the dialog while the upload runs: see onClose().
    m_publishing = true;

    // Zipping and uploading take as long as the project is big: on the worker, like
    // every other request.  Only reads the project's files.
    runAsync( wxString::Format( _( "Publishing '%s'..." ), projectName ),
            [projectPathStd, projectNameStd, projectOut, urlOut, errorOut](
                    const wxString& aServer, const wxString& aToken, COLLAB_REST::ERROR_INFO& )
            {
                wxString url;
                wxString error;

                std::optional<nlohmann::json> published =
                        COLLAB_PROJECT::CreateAndShare( aServer, aToken,
                                                        wxString::FromUTF8( projectPathStd ),
                                                        wxString::FromUTF8( projectNameStd ),
                                                        url, error );

                *urlOut = url.ToStdString( wxConvUTF8 );
                *errorOut = error.ToStdString( wxConvUTF8 );

                if( !published )
                    return false;

                *projectOut = *published;
                return true;
            },
            [this, projectPathStd, projectNameStd, proFileStd, projectOut, urlOut, errorOut](
                    bool aOk, const COLLAB_REST::ERROR_INFO& )
            {
                m_publishing = false;
                updateControls();

                wxString projectId = aOk ? jsonStr( *projectOut, "projectId" ) : wxString();

                if( projectId.IsEmpty() )
                {
                    // An exception in the worker leaves no message behind.
                    wxString error = wxString::FromUTF8( *errorOut );

                    if( error.IsEmpty() )
                        error = _( "Publishing the project failed." );

                    wxMessageBox( error, _( "Publish Project Online" ), wxOK | wxICON_ERROR,
                                  this );

                    // The upload may have got through before the failure.
                    refresh();
                    return;
                }

                // This folder is the project's local copy from now on, exactly as after
                // File > Publish Project Online: the editors join the live session and
                // Open comes back here instead of downloading a second copy.
                COLLAB_PROJECT::WriteLocalLink( wxString::FromUTF8( projectPathStd ),
                                                wxString::FromUTF8( projectNameStd ),
                                                COLLAB_SESSION::ServerUrl(), projectId );
                COLLAB_PROJECT::RecordLocalCopy( projectId, wxString::FromUTF8( proFileStd ) );

                wxString url = wxString::FromUTF8( *urlOut );
                bool     copied = false;

                if( !url.IsEmpty() && wxTheClipboard->Open() )
                {
                    copied = wxTheClipboard->SetData( new wxTextDataObject( url ) );
                    wxTheClipboard->Close();
                }

                showTrash( false );
                m_selectAfterRefresh = projectId;
                updatePublishable();
                refresh();

                setNotice( copied ? _( "Project published.  Share link copied to the "
                                       "clipboard." )
                                  : _( "Project published.  Choose Share to invite people." ) );
            } );
}


void DIALOG_ONLINE_PROJECTS::newBlankProject()
{
    if( m_busy > 0 || m_signingIn )
        return;

    wxTextEntryDialog dlg( this, _( "Name of the new online project:" ),
                           _( "New Blank Online Project" ) );

    dlg.SetMaxLength( MAX_PROJECT_NAME_CHARS );

    if( dlg.ShowModal() != wxID_OK )
        return;

    wxString name = dlg.GetValue();

    name.Trim( true ).Trim( false );

    if( name.IsEmpty() )
        return;

    // Signed out: sign in first, then carry on by itself.
    whenSignedIn(
            [this, name]()
            {
                createBlankProject( name );
            } );
}


void DIALOG_ONLINE_PROJECTS::createBlankProject( const wxString& aName )
{
    std::shared_ptr<nlohmann::json> projectOut = std::make_shared<nlohmann::json>();

    std::string nameStd = aName.ToStdString( wxConvUTF8 );

    runAsync( wxString::Format( _( "Creating '%s'..." ), aName ),
            [nameStd, projectOut]( const wxString& aServer, const wxString& aToken,
                                   COLLAB_REST::ERROR_INFO& aError )
            {
                std::optional<nlohmann::json> project =
                        COLLAB_REST::CreateBlankProject( aServer, aToken,
                                                         wxString::FromUTF8( nameStd ), &aError );

                if( !project )
                    return false;

                *projectOut = *project;
                return true;
            },
            [this, projectOut]( bool aOk, const COLLAB_REST::ERROR_INFO& aError )
            {
                if( !aOk )
                {
                    showFailure( _( "Creating the online project failed." ),
                                 _( "New Blank Online Project" ), aError );
                    return;
                }

                // openProject() only needs projectId and name, which the new project
                // carries just like a listing row does.
                nlohmann::json project = *projectOut;

                showTrash( false );
                m_selectAfterRefresh = jsonStr( project, "projectId" );
                refresh();

                // A blank project is made to be worked on: straight into it, the same
                // way as opening it from the list.
                openProject( project );
            } );
}


void DIALOG_ONLINE_PROJECTS::onJoinLink( wxCommandEvent& aEvent )
{
    if( m_busy > 0 || m_signingIn )
        return;

    JoinWithLink( wxEmptyString );
}


void DIALOG_ONLINE_PROJECTS::JoinWithLink( const wxString& aLinkOrToken, bool aOpenWithoutAsking )
{
    wxString provided = aLinkOrToken;

    if( provided.IsEmpty() )
    {
        wxTextEntryDialog dlg( this, _( "Share link or invite token:" ),
                               _( "Join Shared Project" ) );

        if( dlg.ShowModal() != wxID_OK )
            return;

        provided = dlg.GetValue();
    }

    wxString linkToken = COLLAB_PROJECT::ParseLinkToken( provided );

    if( linkToken.IsEmpty() )
    {
        wxMessageBox( _( "The share link could not be understood." ), _( "Join Shared Project" ),
                      wxOK | wxICON_ERROR, this );
        return;
    }

    // Signed out: sign in first, then carry on with the join by itself rather
    // than making the user paste the link a second time.
    whenSignedIn(
            [this, linkToken, aOpenWithoutAsking]()
            {
                claimLink( linkToken, aOpenWithoutAsking );
            } );
}


void DIALOG_ONLINE_PROJECTS::claimLink( const wxString& aLinkToken, bool aOpenWithoutAsking )
{
    std::shared_ptr<nlohmann::json> projectOut = std::make_shared<nlohmann::json>();
    std::shared_ptr<std::string>    errorOut = std::make_shared<std::string>();

    std::string linkTokenStd = aLinkToken.ToStdString( wxConvUTF8 );

    runAsync( _( "Joining the shared project..." ),
            [linkTokenStd, projectOut, errorOut]( const wxString& aServer, const wxString& aToken,
                                                  COLLAB_REST::ERROR_INFO& )
            {
                wxString error;

                std::optional<nlohmann::json> project =
                        COLLAB_PROJECT::ClaimAndFetch( aServer, aToken,
                                                       wxString::FromUTF8( linkTokenStd ), error );

                if( !project )
                {
                    *errorOut = error.ToStdString( wxConvUTF8 );
                    return false;
                }

                *projectOut = *project;
                return true;
            },
            [this, projectOut, errorOut, aOpenWithoutAsking]( bool aOk,
                                                              const COLLAB_REST::ERROR_INFO& )
            {
                if( !aOk )
                {
                    // An exception in the worker leaves no message behind.
                    wxString error = wxString::FromUTF8( *errorOut );

                    if( error.IsEmpty() )
                        error = _( "Joining the shared project failed." );

                    wxMessageBox( error, _( "Join Shared Project" ), wxOK | wxICON_ERROR, this );
                    return;
                }

                // openProject() only needs projectId and name, which the fetched
                // project carries just like a listing row does.
                nlohmann::json project = *projectOut;
                wxString       name = jsonStr( project, "name" );

                showTrash( false );
                m_selectAfterRefresh = jsonStr( project, "projectId" );
                refresh();

                // "Open in KiCad Collaborative" on the web already said what to do: go
                // straight to the project.  A pasted link still gets the question.
                if( aOpenWithoutAsking
                    || wxMessageBox( wxString::Format( _( "Joined '%s'.  Open it now?\n\n"
                                                          "A local working copy is downloaded so "
                                                          "the desktop editors can open it; your "
                                                          "edits sync live to everyone in the "
                                                          "session." ),
                                                       name ),
                                     _( "Join Shared Project" ), wxYES_NO | wxICON_QUESTION,
                                     this )
                               == wxYES )
                {
                    openProject( project );
                }
            } );
}
