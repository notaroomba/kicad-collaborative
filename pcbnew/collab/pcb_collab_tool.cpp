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

#include "pcb_collab_tool.h"

#include "pcb_collab_sync.h"

#include <collab/collab_project.h>
#include <collab/collab_rest.h>
#include "dialog_pcb_comments.h"
#include <kiid.h>
#include <router/pns_arc.h>
#include <router/pns_drag_algo.h>
#include <router/pns_itemset.h>
#include <router/pns_line.h>
#include <router/pns_placement_algo.h>
#include <router/pns_router.h>
#include <router/pns_segment.h>
#include <router/router_tool.h>
#include <math/util.h>
#include <tool/actions.h>
#include <tool/tool_manager.h>
#include <tools/pcb_actions.h>
#include <tools/pcb_selection.h>
#include <view/view.h>
#include <view/view_controls.h>

#include <wx/clipbrd.h>
#include <wx/filename.h>
#include <wx/msgdlg.h>
#include <wx/textdlg.h>

/// Cap on how many selection boxes ride along in a presence update; the server
/// rejects presence payloads over 8 KB.
static constexpr size_t MAX_PRESENCE_BOXES = 150;

/// Cap on in-flight ghost segments per presence update (same 8 KB budget).
static constexpr size_t MAX_GHOST_SEGS = 100;

/// Cap on full item ghosts rendered per peer (painter calls are not free).
static constexpr size_t MAX_GHOST_ITEMS = 40;


/// Flatten the router's current in-flight work into wire-format ghost segments:
/// the sections already clicked into place this route (fixed but not yet
/// committed to the board) plus the head being dragged right now.
static void collectRouterGhost( PNS::ROUTER* aRouter, nlohmann::json& aGhost )
{
    if( !aRouter || !aRouter->RoutingInProgress() )
        return;

    auto addChain = [&]( const SHAPE_LINE_CHAIN& aChain, int aWidth )
    {
        for( int ii = 0; ii < aChain.SegmentCount(); ++ii )
        {
            if( aGhost.size() >= MAX_GHOST_SEGS )
                return;

            const SEG seg = aChain.CSegment( ii );

            if( seg.A == seg.B )
                continue;

            aGhost.push_back( { seg.A.x, seg.A.y, seg.B.x, seg.B.y, aWidth } );
        }
    };

    auto addItem = [&]( const PNS::ITEM* item )
    {
        if( !item || aGhost.size() >= MAX_GHOST_SEGS )
            return;

        if( item->Kind() == PNS::ITEM::LINE_T )
        {
            const PNS::LINE* line = static_cast<const PNS::LINE*>( item );
            addChain( line->CLine(), line->Width() );
        }
        else if( item->Kind() == PNS::ITEM::SEGMENT_T )
        {
            const PNS::SEGMENT* seg = static_cast<const PNS::SEGMENT*>( item );
            addChain( seg->CLine(), seg->Width() );
        }
        else if( item->Kind() == PNS::ITEM::ARC_T )
        {
            const PNS::ARC* arc = static_cast<const PNS::ARC*>( item );
            addChain( arc->CLine(), arc->Width() );
        }
    };

    std::vector<PNS::ITEM*> removed, added, heads;
    aRouter->GetUpdatedItems( removed, added, heads );

    for( const PNS::ITEM* item : added )
        addItem( item );

    for( const PNS::ITEM* item : heads )
        addItem( item );

    // Fallback for modes where the node delta is empty (e.g. some drag states).
    if( aGhost.empty() )
    {
        PNS::ITEM_SET traces;

        if( aRouter->Placer() )
            traces = aRouter->Placer()->Traces();
        else if( aRouter->GetDragger() )
            traces = aRouter->GetDragger()->Traces();

        for( const PNS::ITEM* item : traces.CItems() )
            addItem( item );
    }
}


PCB_COLLAB_TOOL::PCB_COLLAB_TOOL() :
        PCB_TOOL_BASE( "pcbnew.Collab" ),
        m_presenceDirty( false ),
        m_ownsSession( false )
{
    m_timer.SetOwner( this );
    Bind( wxEVT_TIMER, &PCB_COLLAB_TOOL::onTimer, this );
}


PCB_COLLAB_TOOL::~PCB_COLLAB_TOOL()
{
    *m_alive = false;

    m_timer.Stop();

    // The session is process-wide and outlives every frame, so a registration
    // left behind here is a dangling COLLAB_DOC_ADAPTER*.
    if( COLLAB_SESSION::Exists() )
        COLLAB_SESSION::Get().ForgetAdapter( this );
}


bool PCB_COLLAB_TOOL::Init()
{
    // The 100 ms tick is a cheap no-op until a session (started here or in
    // eeschema) goes live.
    m_timer.Start( 100 );

    return true;
}


void PCB_COLLAB_TOOL::Reset( RESET_REASON aReason )
{
    PCB_TOOL_BASE::Reset( aReason );

    if( aReason == SHUTDOWN )
    {
        // Leave the session while the frame and view are still alive; the tool
        // destructor runs too late to touch either.  Closing the board editor
        // must not disconnect a session eeschema owns, so only a session we
        // started ourselves is torn down wholesale.
        m_timer.Stop();

        if( m_ownsSession )
            endSession();
        else
            leaveDoc();

        return;
    }

    // A board (re)load rebuilds the view contents, dropping our overlay item and
    // invalidating cached selection boxes. Nothing else re-adds it: rebuild
    // otherwise only runs on a presence change, and idle peers send nothing.
    rebuildOverlay();
}


int PCB_COLLAB_TOOL::StartSession( const TOOL_EVENT& aEvent )
{
    withSignIn(
            [this]( const wxString& aToken )
            {
                startWithToken( aToken );
            } );

    return 0;
}


int PCB_COLLAB_TOOL::JoinSession( const TOOL_EVENT& aEvent )
{
    PCB_EDIT_FRAME*   editFrame = frame<PCB_EDIT_FRAME>();
    wxTextEntryDialog dlg( editFrame, _( "Share link or invite token:" ),
                           _( "Join Shared Project" ) );

    if( dlg.ShowModal() != wxID_OK )
        return 0;

    wxString linkToken = COLLAB_PROJECT::ParseLinkToken( dlg.GetValue() );

    if( linkToken.IsEmpty() )
    {
        editFrame->ShowInfoBarError( _( "The share link could not be understood." ) );
        return 0;
    }

    withSignIn(
            [this, linkToken]( const wxString& aToken )
            {
                joinWithToken( aToken, linkToken );
            } );

    return 0;
}


int PCB_COLLAB_TOOL::LeaveSession( const TOOL_EVENT& aEvent )
{
    endSession();
    frame<PCB_EDIT_FRAME>()->SetStatusText( wxEmptyString, 0 );

    return 0;
}


void PCB_COLLAB_TOOL::withSignIn( std::function<void( const wxString& aToken )> aContinuation )
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
                    frame<PCB_EDIT_FRAME>()->ShowInfoBarError( aTokenOrError );
            },
            error );

    if( !started )
        frame<PCB_EDIT_FRAME>()->ShowInfoBarError( error );
}


void PCB_COLLAB_TOOL::joinWithToken( const wxString& aToken, const wxString& aLinkToken )
{
    wxString error;

    std::optional<nlohmann::json> project =
            COLLAB_PROJECT::ClaimAndFetch( COLLAB_SESSION::ServerUrl(), aToken, aLinkToken,
                                           error );

    if( !project )
    {
        frame<PCB_EDIT_FRAME>()->ShowInfoBarError( error );
        return;
    }

    // Remember the pairing so this copy rejoins automatically next time.
    COLLAB_PROJECT::WriteLocalLink( frame<PCB_EDIT_FRAME>()->Prj().GetProjectPath(),
                                    frame<PCB_EDIT_FRAME>()->Prj().GetProjectName(),
                                    COLLAB_SESSION::ServerUrl(),
                                    wxString::FromUTF8( project->value( "projectId", "" ) ) );

    beginSession( *project, aToken, aLinkToken );
}


void PCB_COLLAB_TOOL::startWithToken( const wxString& aToken )
{
    PCB_EDIT_FRAME* editFrame = frame<PCB_EDIT_FRAME>();
    wxString        url;
    wxString        error;

    std::optional<nlohmann::json> project =
            COLLAB_PROJECT::CreateAndShare( COLLAB_SESSION::ServerUrl(), aToken,
                                            editFrame->Prj().GetProjectPath(),
                                            editFrame->Prj().GetProjectName(), url, error );

    if( !project )
    {
        editFrame->ShowInfoBarError( error );
        return;
    }

    if( wxTheClipboard->Open() )
    {
        wxTheClipboard->SetData( new wxTextDataObject( url ) );
        wxTheClipboard->Close();
    }

    // Remember the pairing so this copy rejoins automatically next time.
    COLLAB_PROJECT::WriteLocalLink( editFrame->Prj().GetProjectPath(),
                                    editFrame->Prj().GetProjectName(),
                                    COLLAB_SESSION::ServerUrl(),
                                    wxString::FromUTF8( project->value( "projectId", "" ) ) );

    beginSession( *project, aToken, wxEmptyString );

    wxMessageBox( wxString::Format( _( "Share link copied to the clipboard:\n%s" ), url ),
                  _( "Collaboration Session" ), wxOK | wxICON_INFORMATION, editFrame );
}


void PCB_COLLAB_TOOL::beginSession( const nlohmann::json& aProject, const wxString& aToken,
                                    const wxString& aLinkToken )
{
    // Find our doc before touching any existing session: a failed join must not
    // tear down a session eeschema owns.
    wxString file = boardFile();
    wxString docId;

    if( aProject.contains( "docs" ) && aProject[ "docs" ].is_array() )
    {
        for( const nlohmann::json& doc : aProject[ "docs" ] )
        {
            if( doc.value( "docType", "" ) != "kicad_pcb" )
                continue;

            if( wxString::FromUTF8( doc.value( "path", "" ) ) != file )
                continue;

            wxString candidate = wxString::FromUTF8( doc.value( "docId", "" ) );

            if( !candidate.IsEmpty() )
            {
                docId = candidate;
                break;
            }
        }
    }

    if( docId.IsEmpty() )
    {
        frame<PCB_EDIT_FRAME>()->ShowInfoBarError( _( "The shared project contains no board "
                                                      "matching this one." ) );
        return;
    }

    endSession();

    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    // Publish the full doc list so the schematic editor can find its own docs.
    session.SetProjectDocs( aProject.value( "docs", nlohmann::json::array() ) );

    m_ownsSession = true;

    session.Connect( aToken, aLinkToken );
    joinDoc( docId, file );
    OnSessionStateChanged();
}


void PCB_COLLAB_TOOL::tryAutoJoin()
{
    PCB_EDIT_FRAME* editFrame = frame<PCB_EDIT_FRAME>();

    if( !editFrame || boardFile().IsEmpty() )
        return;

    wxString projectPath = editFrame->Prj().GetProjectPath();

    if( projectPath.IsEmpty() || m_autoJoinProject == projectPath )
        return;

    m_autoJoinProject = projectPath;

    wxString server;
    wxString projectId = COLLAB_PROJECT::ReadLocalLink( projectPath,
                                                        editFrame->Prj().GetProjectName(),
                                                        server );

    if( projectId.IsEmpty() || server != COLLAB_SESSION::ServerUrl() )
        return;

    wxString token = COLLAB_AUTH::StoredToken( server );

    if( token.IsEmpty() )
        return;

    std::optional<nlohmann::json> project =
            COLLAB_REST::GetProject( server, token, projectId );

    if( project )
        beginSession( *project, token, wxEmptyString );
}


void PCB_COLLAB_TOOL::joinDoc( const wxString& aDocId, const wxString& aDocPath )
{
    PCB_EDIT_FRAME* editFrame = frame<PCB_EDIT_FRAME>();

    m_docId = aDocId;
    m_docPath = aDocPath;

    // The sync engine must exist before the join so it sees the join-time messages.
    m_sync = std::make_unique<PCB_COLLAB_SYNC>( editFrame, m_docId );

    // Picks up ops left unacknowledged by a previous run (crash, or offline edits).
    m_sync->OpenJournal( editFrame->Prj().GetProjectPath(), editFrame->Prj().GetProjectName() );

    COLLAB_SESSION::Get().JoinDoc( m_docId, std::nullopt, this );

    fetchComments();
}


namespace
{
/// nlohmann's value() with a default still throws when the key holds null
/// (roots carry "parentId": null); this doesn't.
long long jsonNumber( const nlohmann::json& aObj, const char* aKey, long long aDefault )
{
    auto it = aObj.find( aKey );

    return it != aObj.end() && it->is_number() ? it->get<long long>() : aDefault;
}
} // anonymous namespace


void PCB_COLLAB_TOOL::fetchComments()
{
    std::shared_ptr<bool> alive = m_alive;
    std::string server = COLLAB_SESSION::ServerUrl().ToStdString( wxConvUTF8 );
    std::string token =
            COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() ).ToStdString( wxConvUTF8 );
    std::string docId = m_docId.ToStdString( wxConvUTF8 );

    COLLAB_SESSION::Get().RunAsync(
            [this, alive, server, token, docId]()
            {
                std::optional<nlohmann::json> listing = COLLAB_REST::ListComments(
                        wxString::FromUTF8( server ), wxString::FromUTF8( token ),
                        wxString::FromUTF8( docId ) );

                nlohmann::json comments = listing && listing->contains( "comments" )
                                                  ? ( *listing )[ "comments" ]
                                                  : nlohmann::json::array();

                wxTheApp->CallAfter(
                        [this, alive, comments, docId]()
                        {
                            if( !*alive || m_docId.ToStdString( wxConvUTF8 ) != docId )
                                return;

                            m_comments = comments;

                            if( wxGetEnv( wxS( "KICAD_LOG_TO_STDERR" ), nullptr ) )
                            {
                                fprintf( stderr, "COLLAB comments: %zu loaded\n",
                                         (size_t) m_comments.size() );
                            }

                            rebuildCommentPins();
                        } );
            } );
}


void PCB_COLLAB_TOOL::OnComment( const nlohmann::json& aMsg )
{
    const nlohmann::json& payload =
            aMsg.contains( "comment" ) ? aMsg[ "comment" ] : nlohmann::json();

    if( !payload.is_object() )
        return;

    std::string    action = payload.value( "action", "" );
    nlohmann::json entry = payload.contains( "comment" ) ? payload[ "comment" ]
                                                         : nlohmann::json();

    if( !entry.is_object() )
        return;

    long long id = jsonNumber( entry, "id", -1 );

    if( action == "deleted" )
    {
        nlohmann::json kept = nlohmann::json::array();

        for( const nlohmann::json& c : m_comments )
        {
            if( jsonNumber( c, "id", -1 ) != id && jsonNumber( c, "parentId", -1 ) != id )
                kept.push_back( c );
        }

        m_comments = std::move( kept );
    }
    else if( action == "updated" )
    {
        for( nlohmann::json& c : m_comments )
        {
            if( jsonNumber( c, "id", -1 ) == id )
                c = entry;
        }
    }
    else if( action == "added" )
    {
        bool present = false;

        for( const nlohmann::json& c : m_comments )
            present |= jsonNumber( c, "id", -1 ) == id;

        if( !present )
            m_comments.push_back( entry );
    }

    if( wxGetEnv( wxS( "KICAD_LOG_TO_STDERR" ), nullptr ) )
        fprintf( stderr, "COLLAB comment %s: id=%lld\n", action.c_str(), id );

    rebuildCommentPins();

    if( m_commentsDlg )
        m_commentsDlg->Reload();
}


int PCB_COLLAB_TOOL::ShowComments( const TOOL_EVENT& aEvent )
{
    if( m_docId.IsEmpty() )
    {
        frame<PCB_EDIT_FRAME>()->ShowInfoBarMsg(
                _( "Comments live on shared projects; start or join a session first." ) );
        return 0;
    }

    if( m_commentsDlg )
    {
        m_commentsDlg->Raise();
        return 0;
    }

    VECTOR2I anchor = frame<PCB_EDIT_FRAME>()->GetCanvas()->GetViewControls()
                              ->GetCursorPosition();

    m_commentsDlg = new DIALOG_PCB_COMMENTS(
            frame<PCB_EDIT_FRAME>(), &m_comments, anchor,
            [this, anchor]( const wxString& aBody, long long aParentId )
            {
                postComment( aBody, aParentId, anchor );
            },
            [this]( long long aRootId, bool aResolved )
            {
                resolveComment( aRootId, aResolved );
            } );

    m_commentsDlg->Bind( wxEVT_CLOSE_WINDOW,
                         [this]( wxCloseEvent& aClose )
                         {
                             m_commentsDlg = nullptr;
                             aClose.Skip();
                         } );

    // wx destroys the dialog on close (Destroy via Close default handling
    // needs an explicit call for modeless dialogs).
    m_commentsDlg->Bind( wxEVT_BUTTON,
                         [this]( wxCommandEvent& aCmd )
                         {
                             if( aCmd.GetId() == wxID_CANCEL && m_commentsDlg )
                             {
                                 DIALOG_PCB_COMMENTS* dlg = m_commentsDlg;
                                 m_commentsDlg = nullptr;
                                 dlg->Destroy();
                                 return;
                             }

                             aCmd.Skip();
                         } );

    m_commentsDlg->Show();
    return 0;
}


void PCB_COLLAB_TOOL::postComment( const wxString& aBody, long long aParentId,
                                   const VECTOR2I& aAnchor )
{
    std::string server = COLLAB_SESSION::ServerUrl().ToStdString( wxConvUTF8 );
    std::string token =
            COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() ).ToStdString( wxConvUTF8 );
    std::string docId = m_docId.ToStdString( wxConvUTF8 );
    std::string body = aBody.ToStdString( wxConvUTF8 );
    long long   x = aAnchor.x;
    long long   y = aAnchor.y;

    COLLAB_SESSION::Get().RunAsync(
            [server, token, docId, body, aParentId, x, y]()
            {
                COLLAB_REST::CreateComment( wxString::FromUTF8( server ),
                                            wxString::FromUTF8( token ),
                                            wxString::FromUTF8( docId ),
                                            wxString::FromUTF8( body ), x, y, aParentId );
            } );
}


void PCB_COLLAB_TOOL::resolveComment( long long aRootId, bool aResolved )
{
    std::string server = COLLAB_SESSION::ServerUrl().ToStdString( wxConvUTF8 );
    std::string token =
            COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() ).ToStdString( wxConvUTF8 );

    COLLAB_SESSION::Get().RunAsync(
            [server, token, aRootId, aResolved]()
            {
                COLLAB_REST::SetCommentResolved( wxString::FromUTF8( server ),
                                                 wxString::FromUTF8( token ), aRootId,
                                                 aResolved );
            } );
}


void PCB_COLLAB_TOOL::rebuildCommentPins()
{
    std::vector<COMMENT_PIN> pins;

    for( const nlohmann::json& c : m_comments )
    {
        if( !c.is_object() || !c.value( "parentId", nlohmann::json() ).is_null() )
            continue;

        COMMENT_PIN pin;
        pin.pos = VECTOR2I( jsonNumber( c, "x", 0 ), jsonNumber( c, "y", 0 ) );
        pin.resolved = c.value( "resolved", false );

        long long id = jsonNumber( c, "id", -1 );
        pin.count = 0;

        for( const nlohmann::json& other : m_comments )
        {
            if( jsonNumber( other, "id", -1 ) == id
                || jsonNumber( other, "parentId", -1 ) == id )
                pin.count++;
        }

        pins.push_back( pin );
    }

    m_cursorItem.SetCommentPins( std::move( pins ) );

    if( KIGFX::VIEW* view = getView() )
    {
        view->Update( &m_cursorItem );

        if( frame<PCB_EDIT_FRAME>()->GetCanvas() )
            frame<PCB_EDIT_FRAME>()->GetCanvas()->Refresh();
    }
}


void PCB_COLLAB_TOOL::endSession()
{
    leaveDoc();
    m_ownsSession = false;

    COLLAB_SESSION::Get().Disconnect();
}


void PCB_COLLAB_TOOL::leaveDoc()
{
    m_sync.reset();

    if( !m_docId.IsEmpty() )
        COLLAB_SESSION::Get().LeaveDoc( m_docId );

    m_docId.clear();
    m_docPath.clear();
    m_lastSentState = nlohmann::json();
    m_presenceDirty = false;

    m_comments = nlohmann::json::array();

    if( KIGFX::VIEW* view = getView() )
    {
        m_cursorItem.SetPeers( {} );
        m_cursorItem.SetCommentPins( {} );
        view->Remove( &m_cursorItem );

        if( frame<PCB_EDIT_FRAME>()->GetCanvas() )
            frame<PCB_EDIT_FRAME>()->GetCanvas()->Refresh();
    }
}


wxString PCB_COLLAB_TOOL::boardFile() const
{
    if( !board() || board()->GetFileName().IsEmpty() )
        return wxEmptyString;

    wxFileName fn( board()->GetFileName() );
    fn.MakeRelativeTo( frame<PCB_EDIT_FRAME>()->Prj().GetProjectPath() );

    return fn.GetFullPath( wxPATH_UNIX );
}


int PCB_COLLAB_TOOL::onSelectionChange( const TOOL_EVENT& aEvent )
{
    m_presenceDirty = true;

    return 0;
}


void PCB_COLLAB_TOOL::onTimer( wxTimerEvent& aEvent )
{
    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    if( !session.IsLive() )
    {
        // The doc registration is torn down here, on the tick after the session
        // ends, rather than from OnSessionStateChanged(): the session notifies
        // its adapters while iterating its doc map, so leaving mid-callback
        // would invalidate its iterator.  A session we started ourselves is
        // still CONNECTING at this point, so leave that join alone.
        if( !m_ownsSession && !m_docId.IsEmpty() )
            leaveDoc();

        // A cloud project copy records its server project beside the files; rejoin
        // the live session automatically (once per project) when nothing else in
        // the process owns a session.
        if( session.GetState() == COLLAB_SESSION::STATE::DISCONNECTED && !m_ownsSession )
            tryAutoJoin();

        return;
    }

    wxString file = boardFile();

    if( !m_docId.IsEmpty() && m_docPath != file )
        leaveDoc();

    if( m_docId.IsEmpty() )
    {
        // eeschema owns the session but only joins schematic docs; find the
        // board's doc in the shared project doc list and join it ourselves.
        const nlohmann::json& docs = session.ProjectDocs();

        if( file.IsEmpty() || !docs.is_array() )
            return;

        for( const nlohmann::json& doc : docs )
        {
            if( doc.value( "docType", "" ) != "kicad_pcb" )
                continue;

            if( wxString::FromUTF8( doc.value( "path", "" ) ) != file )
                continue;

            wxString docId = wxString::FromUTF8( doc.value( "docId", "" ) );

            // A malformed entry would otherwise register an adapter under an
            // empty id that leaveDoc() can never match, and retry every tick.
            if( docId.IsEmpty() )
                continue;

            joinDoc( docId, file );
            break;
        }

        if( m_docId.IsEmpty() )
            return;
    }

    VECTOR2D cursor = getViewControls()->GetCursorPosition();
    BOX2D    viewport = getView()->GetViewport();

    nlohmann::json selectionIds = nlohmann::json::array();
    nlohmann::json boxes = nlohmann::json::array();

    // Send our own bounding boxes rather than only ids: the receiver would
    // otherwise draw them from its own (last committed) copy, so a drag in
    // progress would not be visible until it was committed.  Sending live
    // geometry is also what lets a peer highlight items it does not have yet.
    for( EDA_ITEM* item : selection() )
    {
        selectionIds.push_back( item->m_Uuid.AsStdString() );

        if( boxes.size() < MAX_PRESENCE_BOXES )
        {
            const BOX2I bbox = item->GetBoundingBox();
            boxes.push_back( { bbox.GetX(), bbox.GetY(), bbox.GetWidth(), bbox.GetHeight() } );
        }
    }

    // The route (or track drag) in flight ghosts live on peers' canvases.
    nlohmann::json ghost = nlohmann::json::array();

    if( ROUTER_TOOL* routerTool = m_toolMgr->GetTool<ROUTER_TOOL>() )
        collectRouterGhost( routerTool->Router(), ghost );

    nlohmann::json state = {
        { "cursor", { KiROUND( cursor.x ), KiROUND( cursor.y ) } },
        { "viewport",
          { KiROUND( viewport.GetOrigin().x ), KiROUND( viewport.GetOrigin().y ),
            KiROUND( viewport.GetSize().x ), KiROUND( viewport.GetSize().y ) } },
        { "selection", selectionIds },
        { "boxes", boxes },
        { "ghost", ghost },
        { "sheetFile", file.ToStdString( wxConvUTF8 ) },
    };

    // Re-send unchanged state as a keepalive: the server evicts peers after 30 s
    // of silence, which would make an idle collaborator's cursor vanish.
    bool keepalive = m_lastPresenceSend.IsValid()
                     && wxDateTime::Now() - m_lastPresenceSend >= wxTimeSpan::Seconds( 10 );

    if( !m_presenceDirty && !keepalive && state == m_lastSentState )
        return;

    m_presenceDirty = false;
    m_lastSentState = state;
    m_lastPresenceSend = wxDateTime::Now();

    session.SendPresence( m_docId, state );
}


void PCB_COLLAB_TOOL::OnPresenceChanged()
{
    rebuildOverlay();
}


void PCB_COLLAB_TOOL::OnRemoteOp( const nlohmann::json& aOpMsg )
{
    if( m_sync )
        m_sync->OnRemoteOp( aOpMsg );
}


void PCB_COLLAB_TOOL::OnOpsTail( const nlohmann::json& aOpsMsg )
{
    if( m_sync )
        m_sync->OnOpsTail( aOpsMsg );
}


void PCB_COLLAB_TOOL::OnSnapshot( const nlohmann::json& aSnapshotMsg )
{
    if( m_sync )
        m_sync->OnSnapshot( aSnapshotMsg );
}


void PCB_COLLAB_TOOL::OnAck( const wxString& aClientOpId, long long aSeq )
{
    if( m_sync )
        m_sync->OnAck( aClientOpId, aSeq );
}


void PCB_COLLAB_TOOL::OnSnapshotRequest()
{
    if( m_sync )
        m_sync->OnSnapshotRequest();
}


void PCB_COLLAB_TOOL::OnReset( const wxString& aDocId, long long aSeq )
{
    if( m_sync )
        m_sync->OnReset( aSeq );
}


void PCB_COLLAB_TOOL::OnOpRejected( const wxString& aClientOpId, const wxString& aCode )
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
        frame<PCB_EDIT_FRAME>()->ShowInfoBarError(
                _( "You have view-only access to this shared project. Your change was not "
                   "saved and the board has been refreshed." ) );
    }
    else
    {
        frame<PCB_EDIT_FRAME>()->ShowInfoBarError(
                wxString::Format( _( "The server rejected an edit (%s). The board has been "
                                     "refreshed." ),
                                  aCode ) );
    }
}


void PCB_COLLAB_TOOL::OnSessionStateChanged()
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

    frame<PCB_EDIT_FRAME>()->SetStatusText( msg, 0 );

    // A dead token is the one disconnect that never comes back on its own —
    // say so instead of silently sitting at "offline" forever.
    if( COLLAB_SESSION::Get().GetState() == COLLAB_SESSION::STATE::DISCONNECTED
        && COLLAB_SESSION::Get().DisconnectReason() == wxS( "auth_failed" ) )
    {
        frame<PCB_EDIT_FRAME>()->ShowInfoBarError(
                _( "Collaboration sign-in expired or was revoked, so the live session ended. "
                   "Rejoin from File > Online Projects to continue." ) );
    }

    // Back online: push anything edited while disconnected. The server dedups
    // by clientOpId, so re-sending an op it already has is a no-op.
    if( m_sync && COLLAB_SESSION::Get().IsLive() )
        m_sync->ReplayUnacked();
}


void PCB_COLLAB_TOOL::rebuildOverlay()
{
    KIGFX::VIEW* view = getView();

    if( !view || !board() )
        return;

    std::vector<REMOTE_PEER_DRAW> draws;
    wxString                      file = boardFile();

    if( !m_docId.IsEmpty() )
    {
        for( const auto& [clientId, peer] : COLLAB_SESSION::Get().Peers( m_docId ) )
        {
            if( !peer.state.is_object() )
                continue;

            // A peer only renders when they are looking at this board file.
            if( wxString::FromUTF8( peer.state.value( "sheetFile", "" ) ) != file )
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
                // Footprints paint their children as separate view items, so
                // expand them here.
                if( peer.state.contains( "selection" ) && peer.state[ "selection" ].is_array() )
                {
                    const nlohmann::json& ids = peer.state[ "selection" ];
                    const nlohmann::json& boxesJson = peer.state[ "boxes" ];

                    for( size_t ii = 0; ii < ids.size() && ii < boxesJson.size()
                                        && draw.ghostItems.size() < MAX_GHOST_ITEMS; ++ii )
                    {
                        if( !ids[ ii ].is_string() || !boxesJson[ ii ].is_array()
                            || boxesJson[ ii ].size() < 4 )
                            continue;

                        KIID kiid( wxString::FromUTF8( ids[ ii ].get<std::string>() ) );
                        BOARD_ITEM* item = board()->ResolveItem( kiid, true );

                        if( !item || item->GetParent() != board() )
                            continue;

                        VECTOR2I offset( boxesJson[ ii ][ 0 ].get<int>()
                                                 - item->GetBoundingBox().GetX(),
                                         boxesJson[ ii ][ 1 ].get<int>()
                                                 - item->GetBoundingBox().GetY() );

                        // Only ghost items that are actually displaced (mid-drag).
                        if( std::abs( offset.x ) <= 1 && std::abs( offset.y ) <= 1 )
                            continue;

                        draw.ghostItems.push_back( { item, offset } );

                        item->RunOnChildren(
                                [&]( BOARD_ITEM* aChild )
                                {
                                    if( draw.ghostItems.size() < MAX_GHOST_ITEMS )
                                        draw.ghostItems.push_back( { aChild, offset } );
                                },
                                RECURSE_MODE::RECURSE );
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

                    if( BOARD_ITEM* item = board()->ResolveItem( kiid, true ) )
                        draw.selectionBoxes.push_back( item->GetBoundingBox() );
                }
            }

            // In-flight route/drag segments the peer is pushing right now.
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

    // A board reload rebuilds the view wholesale, silently dropping our item,
    // so re-add it every time; Remove() is a no-op when it is not in the view.
    view->Remove( &m_cursorItem );
    view->Add( &m_cursorItem );
    view->Update( &m_cursorItem );

    if( frame<PCB_EDIT_FRAME>()->GetCanvas() )
        frame<PCB_EDIT_FRAME>()->GetCanvas()->Refresh();
}


void PCB_COLLAB_TOOL::setTransitions()
{
    Go( &PCB_COLLAB_TOOL::StartSession,      PCB_ACTIONS::collabStartSession.MakeEvent() );
    Go( &PCB_COLLAB_TOOL::JoinSession,       PCB_ACTIONS::collabJoinSession.MakeEvent() );
    Go( &PCB_COLLAB_TOOL::LeaveSession,      PCB_ACTIONS::collabLeaveSession.MakeEvent() );
    Go( &PCB_COLLAB_TOOL::ShowComments,      PCB_ACTIONS::collabComments.MakeEvent() );

    Go( &PCB_COLLAB_TOOL::onSelectionChange, EVENTS::PointSelectedEvent );
    Go( &PCB_COLLAB_TOOL::onSelectionChange, EVENTS::SelectedEvent );
    Go( &PCB_COLLAB_TOOL::onSelectionChange, EVENTS::UnselectedEvent );
    Go( &PCB_COLLAB_TOOL::onSelectionChange, EVENTS::ClearedEvent );
}
