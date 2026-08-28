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

#include "sch_collab_tool.h"

#include "sch_collab_sync.h"

#include <collab/collab_rest.h>
#include <kiid.h>
#include <math/util.h>
#include <sch_screen.h>
#include <sch_sheet_path.h>
#include <schematic.h>
#include <tools/sch_actions.h>
#include <view/view.h>
#include <view/view_controls.h>

#include <wx/clipbrd.h>
#include <wx/dir.h>
#include <wx/filename.h>
#include <wx/log.h>
#include <wx/msgdlg.h>
#include <wx/mstream.h>
#include <wx/textdlg.h>
#include <wx/wfstream.h>
#include <wx/zipstrm.h>

static const wxChar* const traceCollab = wxT( "COLLAB" );


SCH_COLLAB_TOOL::SCH_COLLAB_TOOL() :
        SCH_TOOL_BASE<SCH_EDIT_FRAME>( "eeschema.Collab" ),
        m_presenceDirty( false )
{
    m_timer.SetOwner( this );
    Bind( wxEVT_TIMER, &SCH_COLLAB_TOOL::onTimer, this );
}


SCH_COLLAB_TOOL::~SCH_COLLAB_TOOL()
{
    m_timer.Stop();

    // The session is process-wide and outlives every frame, so a registration
    // left behind here is a dangling COLLAB_DOC_ADAPTER*.
    if( COLLAB_SESSION::Exists() )
        COLLAB_SESSION::Get().ForgetAdapter( this );
}


void SCH_COLLAB_TOOL::Reset( RESET_REASON aReason )
{
    SCH_TOOL_BASE<SCH_EDIT_FRAME>::Reset( aReason );

    if( aReason == SHUTDOWN )
    {
        // Leave the session while the frame and view are still alive; the tool
        // destructor runs too late to touch either.
        if( sessionActive() )
            endSession();

        return;
    }

    // A schematic (re)load rebuilds the view contents, dropping our overlay item;
    // the next rebuildOverlay() re-adds it.
}


int SCH_COLLAB_TOOL::StartSession( const TOOL_EVENT& aEvent )
{
    withSignIn(
            [this]( const wxString& aToken )
            {
                startWithToken( aToken );
            } );

    return 0;
}


int SCH_COLLAB_TOOL::JoinSession( const TOOL_EVENT& aEvent )
{
    wxTextEntryDialog dlg( m_frame, _( "Share link or invite token:" ),
                           _( "Join Shared Project" ) );

    if( dlg.ShowModal() != wxID_OK )
        return 0;

    wxString linkToken = parseLinkToken( dlg.GetValue() );

    if( linkToken.IsEmpty() )
    {
        m_frame->ShowInfoBarError( _( "The share link could not be understood." ) );
        return 0;
    }

    withSignIn(
            [this, linkToken]( const wxString& aToken )
            {
                joinWithToken( aToken, linkToken );
            } );

    return 0;
}


int SCH_COLLAB_TOOL::LeaveSession( const TOOL_EVENT& aEvent )
{
    endSession();
    m_frame->SetStatusText( wxEmptyString, 0 );

    return 0;
}


void SCH_COLLAB_TOOL::withSignIn( std::function<void( const wxString& aToken )> aContinuation )
{
    wxString token = COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() );

    if( !token.IsEmpty() )
    {
        aContinuation( token );
        return;
    }

    wxString error;

    bool started = m_auth.SignIn(
            COLLAB_SESSION::ServerUrl(),
            [this, aContinuation]( bool aSuccess, const wxString& aTokenOrError )
            {
                if( aSuccess )
                    aContinuation( aTokenOrError );
                else
                    m_frame->ShowInfoBarError( aTokenOrError );
            },
            error );

    if( !started )
        m_frame->ShowInfoBarError( error );
}


void SCH_COLLAB_TOOL::joinWithToken( const wxString& aToken, const wxString& aLinkToken )
{
    wxString server = COLLAB_SESSION::ServerUrl();

    std::optional<nlohmann::json> claim = COLLAB_REST::ClaimLink( server, aToken, aLinkToken );

    if( !claim )
    {
        m_frame->ShowInfoBarError( _( "The share link is invalid or has expired." ) );
        return;
    }

    wxString projectId = wxString::FromUTF8( claim->value( "projectId", "" ) );

    std::optional<nlohmann::json> project = COLLAB_REST::GetProject( server, aToken, projectId );

    if( !project )
    {
        m_frame->ShowInfoBarError( _( "Unable to fetch the shared project." ) );
        return;
    }

    beginSession( *project, aToken, aLinkToken );
}


void SCH_COLLAB_TOOL::startWithToken( const wxString& aToken )
{
    wxString server = COLLAB_SESSION::ServerUrl();

    std::string zipBytes = zipProjectFiles( m_frame->Prj().GetProjectPath() );

    if( zipBytes.empty() )
    {
        m_frame->ShowInfoBarError( _( "No project files found to share.  Save the project "
                                      "first." ) );
        return;
    }

    std::optional<nlohmann::json> project =
            COLLAB_REST::CreateProject( server, aToken, m_frame->Prj().GetProjectName(),
                                        zipBytes );

    if( !project )
    {
        m_frame->ShowInfoBarError( _( "Uploading the project to the collaboration server "
                                      "failed." ) );
        return;
    }

    wxString projectId = wxString::FromUTF8( project->value( "projectId", "" ) );

    std::optional<nlohmann::json> link =
            COLLAB_REST::CreateShareLink( server, aToken, projectId, wxS( "editor" ) );

    if( !link )
    {
        m_frame->ShowInfoBarError( _( "Creating the share link failed." ) );
        return;
    }

    wxString url = wxString::FromUTF8( link->value( "url", "" ) );

    if( wxTheClipboard->Open() )
    {
        wxTheClipboard->SetData( new wxTextDataObject( url ) );
        wxTheClipboard->Close();
    }

    beginSession( *project, aToken, wxEmptyString );

    wxMessageBox( wxString::Format( _( "Share link copied to the clipboard:\n%s" ), url ),
                  _( "Collaboration Session" ), wxOK | wxICON_INFORMATION, m_frame );
}


void SCH_COLLAB_TOOL::beginSession( const nlohmann::json& aProject, const wxString& aToken,
                                    const wxString& aLinkToken )
{
    endSession();

    // Publish the full doc list so the board editor can find and join its own doc.
    COLLAB_SESSION::Get().SetProjectDocs( aProject.value( "docs", nlohmann::json::array() ) );

    if( aProject.contains( "docs" ) && aProject[ "docs" ].is_array() )
    {
        for( const nlohmann::json& doc : aProject[ "docs" ] )
        {
            if( doc.value( "docType", "" ) != "kicad_sch" )
                continue;

            wxString docId = wxString::FromUTF8( doc.value( "docId", "" ) );
            wxString path = wxString::FromUTF8( doc.value( "path", "" ) );

            if( docId.IsEmpty() || path.IsEmpty() )
                continue;

            m_docIdByPath[ path ] = docId;
            m_pathByDocId[ docId ] = path;
        }
    }

    if( m_pathByDocId.empty() )
    {
        m_frame->ShowInfoBarError( _( "The shared project contains no schematic documents." ) );
        return;
    }

    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    session.Connect( aToken, aLinkToken );

    // The sync engine must exist before the joins so it sees the join-time messages.
    m_sync = std::make_unique<SCH_COLLAB_SYNC>( m_frame, m_docIdByPath );

    // Picks up ops left unacknowledged by a previous run (crash, or offline edits).
    m_sync->OpenJournal( m_frame->Prj().GetProjectPath(), m_frame->Prj().GetProjectName() );

    for( const auto& [docId, path] : m_pathByDocId )
        session.JoinDoc( docId, std::nullopt, this );

    // Live cursors only appear when both sides display the same file.
    if( m_docIdByPath.find( currentSheetFile() ) == m_docIdByPath.end() )
    {
        m_frame->ShowInfoBarMsg( _( "Joined the shared project.  Open the same project locally "
                                    "to see live cursors." ) );
    }

    m_lastSheetFile = currentSheetFile();
    m_timer.Start( 100 );
    OnSessionStateChanged();
}


void SCH_COLLAB_TOOL::endSession()
{
    m_timer.Stop();
    m_sync.reset();

    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    for( const auto& [docId, path] : m_pathByDocId )
        session.LeaveDoc( docId );

    session.Disconnect();

    m_docIdByPath.clear();
    m_pathByDocId.clear();
    m_lastSentState = nlohmann::json();
    m_lastSentDocId.clear();
    m_presenceDirty = false;

    if( KIGFX::VIEW* view = getView() )
    {
        m_cursorItem.SetPeers( {} );
        view->Remove( &m_cursorItem );

        if( m_frame->GetCanvas() )
            m_frame->GetCanvas()->Refresh();
    }
}


wxString SCH_COLLAB_TOOL::currentSheetFile() const
{
    if( !m_frame || !m_frame->GetScreen() )
        return wxEmptyString;

    wxFileName fn( m_frame->GetScreen()->GetFileName() );
    fn.MakeRelativeTo( m_frame->Prj().GetProjectPath() );

    return fn.GetFullPath( wxPATH_UNIX );
}


wxString SCH_COLLAB_TOOL::currentDocId() const
{
    auto it = m_docIdByPath.find( currentSheetFile() );

    return it == m_docIdByPath.end() ? wxString() : it->second;
}


int SCH_COLLAB_TOOL::onSelectionChange( const TOOL_EVENT& aEvent )
{
    m_presenceDirty = true;

    return 0;
}


void SCH_COLLAB_TOOL::onTimer( wxTimerEvent& aEvent )
{
    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    if( !sessionActive() || !session.IsLive() || !m_frame )
        return;

    wxString sheetFile = currentSheetFile();

    // Changing sheets changes which peers are visible.
    if( sheetFile != m_lastSheetFile )
    {
        m_lastSheetFile = sheetFile;
        rebuildOverlay();
    }

    auto docIt = m_docIdByPath.find( sheetFile );

    if( docIt == m_docIdByPath.end() )
        return;

    const wxString& docId = docIt->second;

    VECTOR2D cursor = getViewControls()->GetCursorPosition();
    BOX2D    viewport = getView()->GetViewport();

    nlohmann::json selection = nlohmann::json::array();

    for( EDA_ITEM* item : m_selectionTool->GetSelection() )
        selection.push_back( item->m_Uuid.AsStdString() );

    nlohmann::json state = {
        { "cursor", { KiROUND( cursor.x ), KiROUND( cursor.y ) } },
        { "viewport",
          { KiROUND( viewport.GetOrigin().x ), KiROUND( viewport.GetOrigin().y ),
            KiROUND( viewport.GetSize().x ), KiROUND( viewport.GetSize().y ) } },
        { "selection", selection },
        { "sheetFile", sheetFile.ToStdString( wxConvUTF8 ) },
        { "sheetPath", m_frame->GetCurrentSheet().PathAsString().ToStdString( wxConvUTF8 ) },
    };

    if( !m_presenceDirty && docId == m_lastSentDocId && state == m_lastSentState )
        return;

    m_presenceDirty = false;
    m_lastSentDocId = docId;
    m_lastSentState = state;

    session.SendPresence( docId, state );
}


void SCH_COLLAB_TOOL::OnPresenceChanged()
{
    rebuildOverlay();
}


void SCH_COLLAB_TOOL::OnRemoteOp( const nlohmann::json& aOpMsg )
{
    if( m_sync )
        m_sync->OnRemoteOp( aOpMsg );
}


void SCH_COLLAB_TOOL::OnOpsTail( const nlohmann::json& aOpsMsg )
{
    if( m_sync )
        m_sync->OnOpsTail( aOpsMsg );
}


void SCH_COLLAB_TOOL::OnSnapshot( const nlohmann::json& aSnapshotMsg )
{
    if( m_sync )
        m_sync->OnSnapshot( aSnapshotMsg );
}


void SCH_COLLAB_TOOL::OnAck( const wxString& aClientOpId, long long aSeq )
{
    if( m_sync )
        m_sync->OnAck( aClientOpId, aSeq );
}


void SCH_COLLAB_TOOL::OnSnapshotRequest()
{
    if( m_sync )
        m_sync->OnSnapshotRequest();
}


void SCH_COLLAB_TOOL::OnReset( long long aSeq )
{
    if( m_sync )
        m_sync->OnReset( aSeq );
}


void SCH_COLLAB_TOOL::OnSessionStateChanged()
{
    if( !sessionActive() )
        return;

    wxString msg;

    switch( COLLAB_SESSION::Get().GetState() )
    {
    case COLLAB_SESSION::STATE::LIVE:         msg = _( "Collaboration: live" );          break;
    case COLLAB_SESSION::STATE::CONNECTING:   msg = _( "Collaboration: connecting..." ); break;
    case COLLAB_SESSION::STATE::DISCONNECTED: msg = _( "Collaboration: offline" );       break;
    }

    m_frame->SetStatusText( msg, 0 );

    // Back online: push anything edited while disconnected. The server dedups
    // by clientOpId, so re-sending an op it already has is a no-op.
    if( m_sync && COLLAB_SESSION::Get().IsLive() )
        m_sync->ReplayUnacked();
}


void SCH_COLLAB_TOOL::rebuildOverlay()
{
    KIGFX::VIEW* view = getView();

    if( !view || !m_frame )
        return;

    std::vector<REMOTE_PEER_DRAW> draws;
    wxString                      docId = currentDocId();
    wxString                      sheetFile = currentSheetFile();

    if( !docId.IsEmpty() )
    {
        for( const auto& [clientId, peer] : COLLAB_SESSION::Get().Peers( docId ) )
        {
            if( !peer.state.is_object() )
                continue;

            // A peer only renders on the sheet they are actually looking at.
            if( wxString::FromUTF8( peer.state.value( "sheetFile", "" ) ) != sheetFile )
                continue;

            REMOTE_PEER_DRAW draw;
            draw.label = peer.name.IsEmpty() ? peer.login : peer.name;
            draw.color = COLLAB_CURSOR_ITEM::ParsePeerColor( peer.color );

            if( peer.state.contains( "cursor" ) && peer.state[ "cursor" ].is_array()
                && peer.state[ "cursor" ].size() >= 2 )
            {
                draw.cursor = VECTOR2I( peer.state[ "cursor" ][ 0 ].get<int>(),
                                        peer.state[ "cursor" ][ 1 ].get<int>() );
                draw.hasCursor = true;
            }

            if( peer.state.contains( "selection" ) && peer.state[ "selection" ].is_array() )
            {
                for( const nlohmann::json& id : peer.state[ "selection" ] )
                {
                    if( !id.is_string() )
                        continue;

                    KIID kiid( wxString::FromUTF8( id.get<std::string>() ) );

                    if( SCH_ITEM* item = m_frame->Schematic().ResolveItem( kiid, nullptr, true ) )
                        draw.selectionBoxes.push_back( item->GetBoundingBox() );
                }
            }

            if( draw.hasCursor || !draw.selectionBoxes.empty() )
                draws.push_back( std::move( draw ) );
        }
    }

    m_cursorItem.SetPeers( std::move( draws ) );

    // The sch view is rebuilt wholesale on sheet changes, silently dropping our
    // item, so re-add it every time; Remove() is a no-op when it is not in the view.
    view->Remove( &m_cursorItem );
    view->Add( &m_cursorItem );
    view->Update( &m_cursorItem );

    if( m_frame->GetCanvas() )
        m_frame->GetCanvas()->Refresh();
}


wxString SCH_COLLAB_TOOL::parseLinkToken( const wxString& aInput )
{
    wxString input = aInput;
    input.Trim( true ).Trim( false );

    int pos = input.Find( wxS( "/j/" ) );

    if( pos != wxNOT_FOUND )
        input = input.Mid( pos + 3 );

    // Strip any trailing URL components.
    input = input.BeforeFirst( '/' ).BeforeFirst( '?' ).BeforeFirst( '#' );

    return input;
}


std::string SCH_COLLAB_TOOL::zipProjectFiles( const wxString& aProjectPath )
{
    wxArrayString files;
    wxDir::GetAllFiles( aProjectPath, &files, wxEmptyString, wxDIR_FILES );

    wxMemoryOutputStream memStream;
    int                  entries = 0;

    {
        wxZipOutputStream zipStream( memStream );

        for( size_t i = 0; i < files.GetCount(); ++i )
        {
            wxFileName fn( files[ i ] );
            wxString   ext = fn.GetExt().Lower();
            wxString   name = fn.GetFullName();

            bool wanted = ext == wxS( "kicad_pro" ) || ext == wxS( "kicad_sch" )
                          || ext == wxS( "kicad_pcb" ) || name == wxS( "sym-lib-table" )
                          || name == wxS( "fp-lib-table" );

            if( !wanted )
                continue;

            wxFFileInputStream input( files[ i ] );

            if( !input.IsOk() )
                continue;

            zipStream.PutNextEntry( name );
            zipStream.Write( input );
            entries++;
        }

        if( !zipStream.Close() || entries == 0 )
            return std::string();
    }

    size_t size = memStream.GetSize();

    if( size == 0 )
        return std::string();

    std::string bytes;
    bytes.resize( size );
    memStream.CopyTo( bytes.data(), size );

    return bytes;
}


void SCH_COLLAB_TOOL::setTransitions()
{
    Go( &SCH_COLLAB_TOOL::StartSession,      SCH_ACTIONS::collabStartSession.MakeEvent() );
    Go( &SCH_COLLAB_TOOL::JoinSession,       SCH_ACTIONS::collabJoinSession.MakeEvent() );
    Go( &SCH_COLLAB_TOOL::LeaveSession,      SCH_ACTIONS::collabLeaveSession.MakeEvent() );

    Go( &SCH_COLLAB_TOOL::onSelectionChange, EVENTS::PointSelectedEvent );
    Go( &SCH_COLLAB_TOOL::onSelectionChange, EVENTS::SelectedEvent );
    Go( &SCH_COLLAB_TOOL::onSelectionChange, EVENTS::UnselectedEvent );
    Go( &SCH_COLLAB_TOOL::onSelectionChange, EVENTS::ClearedEvent );
}
