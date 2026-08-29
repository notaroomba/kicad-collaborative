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

#include <collab/collab_project.h>
#include <collab/collab_rest.h>
#include <kiid.h>
#include <math/util.h>
#include <sch_screen.h>
#include <sch_sheet_path.h>
#include <schematic.h>
#include <sch_line.h>
#include <tools/sch_actions.h>
#include <tools/sch_line_wire_bus_tool.h>
#include <view/view.h>
#include <view/view_controls.h>

#include <wx/clipbrd.h>
#include <wx/filename.h>
#include <wx/log.h>
#include <wx/msgdlg.h>
#include <wx/textdlg.h>

static const wxChar* const traceCollab = wxT( "COLLAB" );

/// Cap on how many selection boxes ride along in a presence update; the server
/// rejects presence payloads over 8 KB.
static constexpr size_t MAX_PRESENCE_BOXES = 150;

/// Cap on in-flight ghost segments per presence update (same 8 KB budget).
static constexpr size_t MAX_GHOST_SEGS = 100;

/// Cap on full item ghosts rendered per peer (painter calls are not free).
static constexpr size_t MAX_GHOST_ITEMS = 40;


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

    // A cloud project copy records its server project beside the files; rejoin
    // the live session automatically.  Deferred so the load fully completes first.
    if( aReason == RUN || aReason == MODEL_RELOAD || aReason == SUPERMODEL_RELOAD )
    {
        if( !sessionActive() && m_frame
            && m_autoJoinProject != m_frame->Prj().GetProjectPath() )
        {
            CallAfter(
                    [this]()
                    {
                        tryAutoJoin();
                    } );
        }
    }
}


void SCH_COLLAB_TOOL::tryAutoJoin()
{
    if( sessionActive() || !m_frame )
        return;

    wxString projectPath = m_frame->Prj().GetProjectPath();

    if( projectPath.IsEmpty() || m_autoJoinProject == projectPath )
        return;

    m_autoJoinProject = projectPath;

    wxString server;
    wxString projectId = COLLAB_PROJECT::ReadLocalLink( projectPath,
                                                        m_frame->Prj().GetProjectName(), server );

    if( projectId.IsEmpty() || server != COLLAB_SESSION::ServerUrl() )
        return;

    wxString token = COLLAB_AUTH::StoredToken( server );

    if( token.IsEmpty() )
        return;

    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    if( session.GetState() != COLLAB_SESSION::STATE::DISCONNECTED )
    {
        // Another editor in this process already connected the session; join our
        // docs from the published doc list without reconnecting.
        if( session.ProjectDocs().is_array() && !session.ProjectDocs().empty() )
        {
            nlohmann::json project = { { "docs", session.ProjectDocs() } };
            beginSession( project, token, wxEmptyString, false );
        }

        return;
    }

    std::optional<nlohmann::json> project = COLLAB_REST::GetProject( server, token, projectId );

    if( project )
    {
        wxLogTrace( traceCollab, wxS( "auto-joining cloud project %s" ), projectId );
        beginSession( *project, token, wxEmptyString );
    }
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

    wxString linkToken = COLLAB_PROJECT::ParseLinkToken( dlg.GetValue() );

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
    wxString error;

    std::optional<nlohmann::json> project =
            COLLAB_PROJECT::ClaimAndFetch( COLLAB_SESSION::ServerUrl(), aToken, aLinkToken,
                                           error );

    if( !project )
    {
        m_frame->ShowInfoBarError( error );
        return;
    }

    // Remember the pairing so this copy rejoins automatically next time.
    COLLAB_PROJECT::WriteLocalLink( m_frame->Prj().GetProjectPath(),
                                    m_frame->Prj().GetProjectName(),
                                    COLLAB_SESSION::ServerUrl(),
                                    wxString::FromUTF8( project->value( "projectId", "" ) ) );

    beginSession( *project, aToken, aLinkToken );
}


void SCH_COLLAB_TOOL::startWithToken( const wxString& aToken )
{
    wxString url;
    wxString error;

    std::optional<nlohmann::json> project =
            COLLAB_PROJECT::CreateAndShare( COLLAB_SESSION::ServerUrl(), aToken,
                                            m_frame->Prj().GetProjectPath(),
                                            m_frame->Prj().GetProjectName(), url, error );

    if( !project )
    {
        m_frame->ShowInfoBarError( error );
        return;
    }

    if( wxTheClipboard->Open() )
    {
        wxTheClipboard->SetData( new wxTextDataObject( url ) );
        wxTheClipboard->Close();
    }

    // Remember the pairing so this copy rejoins automatically next time.
    COLLAB_PROJECT::WriteLocalLink( m_frame->Prj().GetProjectPath(),
                                    m_frame->Prj().GetProjectName(),
                                    COLLAB_SESSION::ServerUrl(),
                                    wxString::FromUTF8( project->value( "projectId", "" ) ) );

    beginSession( *project, aToken, wxEmptyString );

    wxMessageBox( wxString::Format( _( "Share link copied to the clipboard:\n%s" ), url ),
                  _( "Collaboration Session" ), wxOK | wxICON_INFORMATION, m_frame );
}


void SCH_COLLAB_TOOL::beginSession( const nlohmann::json& aProject, const wxString& aToken,
                                    const wxString& aLinkToken, bool aConnect )
{
    if( aConnect )
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

    if( aConnect )
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
    nlohmann::json boxes = nlohmann::json::array();

    // Send our own bounding boxes rather than only ids: the receiver would
    // otherwise draw them from its own (last committed) copy, so a drag in
    // progress would not be visible until it was committed.  Sending live
    // geometry is also what lets a peer highlight items it does not have yet.
    for( EDA_ITEM* item : m_selectionTool->GetSelection() )
    {
        selection.push_back( item->m_Uuid.AsStdString() );

        if( boxes.size() < MAX_PRESENCE_BOXES )
        {
            const BOX2I bbox = item->GetBoundingBox();
            boxes.push_back( { bbox.GetX(), bbox.GetY(), bbox.GetWidth(), bbox.GetHeight() } );
        }
    }

    // In-flight wire/bus segments ghost live on peers' canvases.
    nlohmann::json ghost = nlohmann::json::array();

    if( SCH_LINE_WIRE_BUS_TOOL* wireTool = m_toolMgr->GetTool<SCH_LINE_WIRE_BUS_TOOL>() )
    {
        for( SCH_LINE* line : wireTool->GetUnfinishedSegments() )
        {
            if( !line || line->GetStartPoint() == line->GetEndPoint() )
                continue;

            if( ghost.size() >= MAX_GHOST_SEGS )
                break;

            ghost.push_back( { line->GetStartPoint().x, line->GetStartPoint().y,
                               line->GetEndPoint().x, line->GetEndPoint().y,
                               line->GetLineWidth() } );
        }
    }

    nlohmann::json state = {
        { "cursor", { KiROUND( cursor.x ), KiROUND( cursor.y ) } },
        { "viewport",
          { KiROUND( viewport.GetOrigin().x ), KiROUND( viewport.GetOrigin().y ),
            KiROUND( viewport.GetSize().x ), KiROUND( viewport.GetSize().y ) } },
        { "selection", selection },
        { "boxes", boxes },
        { "ghost", ghost },
        { "sheetFile", sheetFile.ToStdString( wxConvUTF8 ) },
        { "sheetPath", m_frame->GetCurrentSheet().PathAsString().ToStdString( wxConvUTF8 ) },
    };

    // Re-send unchanged state as a keepalive: the server evicts peers after 30 s
    // of silence, which would make an idle collaborator's cursor vanish.
    bool keepalive = m_lastPresenceSend.IsValid()
                     && wxDateTime::Now() - m_lastPresenceSend >= wxTimeSpan::Seconds( 10 );

    if( !m_presenceDirty && !keepalive && docId == m_lastSentDocId && state == m_lastSentState )
        return;

    m_presenceDirty = false;
    m_lastSentDocId = docId;
    m_lastSentState = state;
    m_lastPresenceSend = wxDateTime::Now();

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


void SCH_COLLAB_TOOL::OnOpRejected( const wxString& aClientOpId, const wxString& aCode )
{
    if( m_sync )
        m_sync->OnOpRejected( aClientOpId );

    // One notice per burst: a drag can produce several rejected ops at once
    // and each would raise its own infobar otherwise.
    if( m_lastRejectNotice.IsValid()
        && wxDateTime::Now() - m_lastRejectNotice < wxTimeSpan::Seconds( 10 ) )
    {
        return;
    }

    m_lastRejectNotice = wxDateTime::Now();

    if( aCode == wxS( "permission_denied" ) )
    {
        m_frame->ShowInfoBarError(
                _( "You have view-only access to this shared project. Your change was not "
                   "saved and the schematic has been refreshed." ) );
    }
    else
    {
        m_frame->ShowInfoBarError(
                wxString::Format( _( "The server rejected an edit (%s). The schematic has "
                                     "been refreshed." ),
                                  aCode ) );
    }
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

    // A dead token is the one disconnect that never comes back on its own —
    // say so instead of silently sitting at "offline" forever.
    if( COLLAB_SESSION::Get().GetState() == COLLAB_SESSION::STATE::DISCONNECTED
        && COLLAB_SESSION::Get().DisconnectReason() == wxS( "auth_failed" ) )
    {
        m_frame->ShowInfoBarError(
                _( "Collaboration sign-in expired or was revoked, so the live session ended. "
                   "Rejoin from File > Online Projects to continue." ) );
    }

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

            // Prefer the sender's own geometry (live during their drags); fall
            // back to resolving ids locally for peers on an older client.
            if( peer.state.contains( "boxes" ) && peer.state[ "boxes" ].is_array() )
            {
                for( const nlohmann::json& box : peer.state[ "boxes" ] )
                {
                    if( !box.is_array() || box.size() < 4 )
                        continue;

                    draw.selectionBoxes.emplace_back(
                            VECTOR2I( box[ 0 ].get<int>(), box[ 1 ].get<int>() ),
                            VECTOR2I( box[ 2 ].get<int>(), box[ 3 ].get<int>() ) );
                }

                // When we hold our own copy of a dragged item, render the real
                // thing at the peer's live position instead of an empty box.
                if( peer.state.contains( "selection" ) && peer.state[ "selection" ].is_array() )
                {
                    const nlohmann::json& ids = peer.state[ "selection" ];
                    const nlohmann::json& boxes = peer.state[ "boxes" ];
                    SCH_SCREEN*           screen = m_frame->GetScreen();

                    for( size_t ii = 0; ii < ids.size() && ii < boxes.size()
                                        && draw.ghostItems.size() < MAX_GHOST_ITEMS; ++ii )
                    {
                        if( !ids[ ii ].is_string() || !boxes[ ii ].is_array()
                            || boxes[ ii ].size() < 4 )
                            continue;

                        KIID kiid( wxString::FromUTF8( ids[ ii ].get<std::string>() ) );
                        SCH_ITEM* item = m_frame->Schematic().ResolveItem( kiid, nullptr, true );

                        if( !item || item->GetParent() != screen )
                            continue;

                        VECTOR2I offset( boxes[ ii ][ 0 ].get<int>()
                                                 - item->GetBoundingBox().GetX(),
                                         boxes[ ii ][ 1 ].get<int>()
                                                 - item->GetBoundingBox().GetY() );

                        // Only ghost items that are actually displaced (i.e. mid-drag).
                        if( std::abs( offset.x ) > 1 || std::abs( offset.y ) > 1 )
                            draw.ghostItems.push_back( { item, offset } );
                    }
                }
            }
            else if( peer.state.contains( "selection" ) && peer.state[ "selection" ].is_array() )
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

            // In-flight wire/bus segments the peer is drawing right now.
            if( peer.state.contains( "ghost" ) && peer.state[ "ghost" ].is_array() )
            {
                for( const nlohmann::json& seg : peer.state[ "ghost" ] )
                {
                    if( !seg.is_array() || seg.size() < 5 )
                        continue;

                    draw.ghostSegs.push_back( { VECTOR2I( seg[ 0 ].get<int>(),
                                                          seg[ 1 ].get<int>() ),
                                                VECTOR2I( seg[ 2 ].get<int>(),
                                                          seg[ 3 ].get<int>() ),
                                                seg[ 4 ].get<int>() } );
                }
            }

            if( draw.hasCursor || !draw.selectionBoxes.empty() || !draw.ghostSegs.empty()
                || !draw.ghostItems.empty() )
            {
                draws.push_back( std::move( draw ) );
            }
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
