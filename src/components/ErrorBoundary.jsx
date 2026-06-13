import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '2rem', color: '#e8e2d4', background: '#0d0d0d', minHeight: '100dvh' }}>
          <h2 style={{ color: '#c9a84c', marginBottom: '1rem' }}>Something went wrong</h2>
          <pre style={{ color: '#c0392b', whiteSpace: 'pre-wrap', fontSize: '0.85rem' }}>
            {this.state.error?.message}
            {'\n\n'}
            {this.state.error?.stack}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: '1.5rem', padding: '0.6rem 1.2rem', background: '#c9a84c', color: '#0d0d0d', border: 'none', borderRadius: 6, cursor: 'pointer' }}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
